import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { env } from '../../config/env';
import { DepositStatus } from '../../domain/enums';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { applySupplierResult as applyBankTransferResult } from '../../modules/bank-transfer/bank-transfer.service';
import { markDepositPaid } from '../../modules/balance/deposit.service';
import { applySupplierResult } from '../../modules/transactions/transaction.service';
import { verifyKipaySignature } from '../../providers/kipay/client';
import { asyncHandler } from '../helpers';

export const webhookRouter = Router();

/**
 * Callback dari TokoVoucher.
 *
 * Tiga prinsip di endpoint ini:
 *
 *  1. SELALU balas 200 setelah payload tersimpan. Pengirim webhook yang
 *     menerima non-200 akan mengirim ulang terus-menerus; kalau kegagalan kita
 *     bersifat permanen, pengiriman ulang itu tidak menolong dan hanya
 *     membanjiri sistem. Payload sudah dicatat, jadi bisa diproses ulang.
 *
 *  2. Webhook bukan satu-satunya sumber kebenaran. Worker rekonsiliasi tetap
 *     memeriksa transaksi yang menggantung, sehingga callback yang tidak
 *     pernah sampai tidak membuat transaksi tergantung selamanya.
 *
 *  3. Verifikasi signature dulu. Tanpa itu siapa pun yang tahu URL-nya bisa
 *     menyatakan transaksi apa pun berhasil.
 *
 * Formula signature webhook TokoVoucher (docs.tokovoucher.net/webhook/post)
 * BEDA dari HMAC generik: header `X-TokoVoucher-Authorization` berisi
 * `md5(member_code:signature_key:ref_id)` -- rumus yang SAMA dipakai untuk
 * menandatangani order (lihat signature() di client.ts), bukan HMAC-SHA256
 * dengan secret terpisah. Karena rumusnya butuh ref_id, verifikasi baru bisa
 * dilakukan setelah body diparse, bukan atas rawBody mentah.
 */
function verifySignature(refId: string, received: string | undefined): boolean {
  if (!env.TOKOVOUCHER_MEMBER_CODE || !env.TOKOVOUCHER_SIGNATURE_KEY) {
    // Tidak dikonfigurasi: tolak, jangan diam-diam menerima. Endpoint yang
    // terbuka lebih berbahaya daripada callback yang tidak jalan.
    logger.error(
      'TOKOVOUCHER_MEMBER_CODE/TOKOVOUCHER_SIGNATURE_KEY belum diisi, callback ditolak',
    );
    return false;
  }
  if (!received) return false;

  const expected = createHash('md5')
    .update(`${env.TOKOVOUCHER_MEMBER_CODE}:${env.TOKOVOUCHER_SIGNATURE_KEY}:${refId}`)
    .digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  // Panjang berbeda membuat timingSafeEqual melempar, jadi dicek lebih dulu.
  return a.length === b.length && timingSafeEqual(a, b);
}

interface CallbackBody {
  ref_id?: string;
  status?: string;
  trx_id?: string;
  sn?: string;
  message?: string;
}

webhookRouter.post(
  '/tokovoucher',
  asyncHandler(async (req, res) => {
    const rawBody = (req as { rawBody?: string }).rawBody ?? JSON.stringify(req.body);
    const body = req.body as CallbackBody;
    const refId = body.ref_id;
    const signature = req.header('x-tokovoucher-authorization') ?? req.header('x-signature');
    const isValid = !!refId && verifySignature(refId, signature);

    await prisma.webhookLog.create({
      data: {
        source: 'tokovoucher',
        payload: rawBody.slice(0, 10_000),
        headers: JSON.stringify({
          'x-tokovoucher-authorization': signature ? '[ada]' : '[tidak ada]',
          'user-agent': req.header('user-agent') ?? null,
        }),
        isValid,
        note: isValid ? null : 'Signature tidak cocok atau ref_id tidak ada',
      },
    });

    if (!isValid) {
      logger.warn({ ip: req.ip }, 'Callback ditolak: signature tidak valid');
      res.status(401).json({ success: false, error: { code: 'INVALID_SIGNATURE' } });
      return;
    }

    if (!refId) {
      res.status(200).json({ success: true, note: 'ref_id tidak ada, diabaikan' });
      return;
    }

    const callbackResult = {
      status: normalizeCallbackStatus(body.status),
      trxId: body.trx_id ?? null,
      serialNumber: body.sn ?? null,
      message: body.message ?? 'Callback supplier',
      price: null,
      raw: body,
    };

    // Bank transfer dan topup e-wallet berbagi satu endpoint callback (docs
    // TokoVoucher tidak membedakan keduanya lewat field apa pun selain
    // ref_id), jadi dicoba di Transaction dulu, baru BankTransfer.
    const tx = await prisma.transaction.findUnique({ where: { refId } });
    if (tx) {
      try {
        await applySupplierResult(tx.id, callbackResult, 'callback');
      } catch (err) {
        // Sudah tercatat di webhook_logs, jadi tetap balas 200 dan biarkan
        // worker rekonsiliasi yang menuntaskan.
        logger.error({ err, refId }, 'Gagal memproses callback transaksi');
      }
      res.status(200).json({ success: true });
      return;
    }

    const bt = await prisma.bankTransfer.findUnique({ where: { refId } });
    if (bt) {
      try {
        await applyBankTransferResult(bt.id, callbackResult, 'callback');
      } catch (err) {
        logger.error({ err, refId }, 'Gagal memproses callback transfer bank');
      }
      res.status(200).json({ success: true });
      return;
    }

    logger.warn({ refId }, 'Callback untuk transaksi yang tidak dikenal');
    res.status(200).json({ success: true, note: 'transaksi tidak dikenal' });
  }),
);

function normalizeCallbackStatus(raw: string | undefined): 'success' | 'pending' | 'failed' {
  const value = String(raw ?? '').toLowerCase().trim();
  if (['sukses', 'success', 'berhasil', '1'].includes(value)) return 'success';
  if (['gagal', 'failed', 'error', 'batal', '2'].includes(value)) return 'failed';
  return 'pending';
}

interface KipayWebhookBody {
  event?: 'transaction.paid' | 'transaction.expired' | 'webhook.test';
  sent_at?: string;
  transaction?: {
    trx_id?: string;
    status?: string;
  };
}

/**
 * Callback dari KiPay (kipay.id/docs, bagian Outgoing Webhook).
 *
 * Prinsipnya sama seperti webhook TokoVoucher di atas -- selalu balas 200
 * setelah payload tercatat, webhook bukan satu-satunya sumber kebenaran
 * (lihat pollPendingKipayDeposits di deposit.service.ts), dan signature
 * WAJIB diverifikasi lebih dulu. Bedanya, signature KiPay dihitung dari raw
 * body dengan HMAC-SHA256 (bukan MD5 seperti TokoVoucher), jadi verifikasi
 * bisa dilakukan SEBELUM body di-parse.
 */
webhookRouter.post(
  '/kipay',
  asyncHandler(async (req, res) => {
    const rawBody = (req as { rawBody?: string }).rawBody ?? JSON.stringify(req.body);
    const signature = req.header('x-webhook-signature');
    const isValid = verifyKipaySignature(rawBody, signature);

    await prisma.webhookLog.create({
      data: {
        source: 'kipay',
        payload: rawBody.slice(0, 10_000),
        headers: JSON.stringify({
          'x-webhook-signature': signature ? '[ada]' : '[tidak ada]',
          'x-webhook-event': req.header('x-webhook-event') ?? null,
          'user-agent': req.header('user-agent') ?? null,
        }),
        isValid,
        note: isValid ? null : 'Signature tidak cocok',
      },
    });

    if (!isValid) {
      logger.warn({ ip: req.ip }, 'Callback KiPay ditolak: signature tidak valid');
      res.status(401).json({ success: false, error: { code: 'INVALID_SIGNATURE' } });
      return;
    }

    const body = req.body as KipayWebhookBody;

    // Payload contoh dari tombol "Test Webhook" di dashboard KiPay, trx_id-nya
    // selalu berprefix TEST- dan bukan transaksi nyata -- cukup diakui, tidak
    // ada apa pun untuk diproses.
    if (body.event === 'webhook.test') {
      res.status(200).json({ success: true, note: 'test webhook diterima' });
      return;
    }

    const trxId = body.transaction?.trx_id;
    if (!trxId) {
      res.status(200).json({ success: true, note: 'trx_id tidak ada, diabaikan' });
      return;
    }

    const deposit = await prisma.deposit.findFirst({ where: { paymentReference: trxId } });
    if (!deposit) {
      logger.warn({ trxId }, 'Callback KiPay untuk deposit yang tidak dikenal');
      res.status(200).json({ success: true, note: 'deposit tidak dikenal' });
      return;
    }

    try {
      if (body.event === 'transaction.paid') {
        await markDepositPaid(deposit.invoiceId, trxId, body.transaction);
      } else if (body.event === 'transaction.expired') {
        await prisma.deposit.updateMany({
          where: { id: deposit.id, status: DepositStatus.PENDING },
          data: { status: DepositStatus.EXPIRED },
        });
      }
    } catch (err) {
      // Sudah tercatat di webhook_logs, jadi tetap balas 200 dan biarkan
      // pollPendingKipayDeposits() yang menuntaskan.
      logger.error({ err, trxId, event: body.event }, 'Gagal memproses callback KiPay');
    }

    res.status(200).json({ success: true });
  }),
);
