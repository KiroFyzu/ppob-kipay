import { env } from '../../config/env';
import { DepositStatus, LedgerType } from '../../domain/enums';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { createKipayTransaction, getKipayTransaction } from '../../providers/kipay/client';
import { KipayUnavailableError } from '../../providers/kipay/types';
import { generateInvoiceId } from '../../utils/refid';
import { postMutation } from './ledger.service';

/**
 * Deposit saldo.
 *
 * MANUAL_TRANSFER dibuat berstatus PENDING dan menunggu konfirmasi admin
 * lewat markDepositPaid() (lihat admin.routes.ts). QRIS dibuat lewat KiPay
 * (kipay.id/docs): tagihan QRIS dibuat sinkron saat createDeposit(), lalu
 * markDepositPaid() yang sama dipanggil oleh webhook KiPay begitu status
 * transaksinya berubah menjadi 'paid' -- satu fungsi, satu tempat saldo
 * benar-benar bertambah, tidak peduli metode atau sumber konfirmasinya.
 */

export const DEPOSIT_METHODS = ['MANUAL_TRANSFER', 'QRIS'] as const;
export type DepositMethod = (typeof DEPOSIT_METHODS)[number];

export interface CreateDepositInput {
  userId: string;
  amount: number;
  method: DepositMethod;
}

export async function createDeposit(input: CreateDepositInput) {
  const { userId, amount, method } = input;

  if (amount < env.DEPOSIT_MIN_AMOUNT) {
    throw badRequest(
      'AMOUNT_TOO_SMALL',
      `Minimal deposit ${env.DEPOSIT_MIN_AMOUNT.toLocaleString('id-ID')}`,
    );
  }
  if (amount > env.DEPOSIT_MAX_AMOUNT) {
    throw badRequest(
      'AMOUNT_TOO_LARGE',
      `Maksimal deposit ${env.DEPOSIT_MAX_AMOUNT.toLocaleString('id-ID')}`,
    );
  }

  if (method === 'QRIS') {
    return createQrisDeposit(userId, amount);
  }

  // Kode unik pada transfer manual: membuat nominal tiap tagihan berbeda
  // sehingga pembayaran masuk bisa dicocokkan tanpa payment gateway.
  const fee = uniqueCode(userId);

  const deposit = await prisma.deposit.create({
    data: {
      userId,
      invoiceId: generateInvoiceId(),
      amount,
      fee,
      totalPaid: amount + fee,
      method,
      status: DepositStatus.PENDING,
      expiredAt: new Date(Date.now() + env.DEPOSIT_EXPIRY_MINUTES * 60 * 1000),
    },
  });

  logger.info(
    { invoiceId: deposit.invoiceId, userId, amount, method },
    'Deposit dibuat',
  );
  return deposit;
}

/**
 * KiPay menghitung kode uniknya sendiri (unique_code, 1-999) dan mengembalikan
 * `amount` gross yang harus dibayar user persis lewat QRIS -- beda dari
 * MANUAL_TRANSFER yang kode uniknya kita hitung sendiri lewat uniqueCode().
 * `fee` di baris ini menyimpan unique_code itu (bukan biaya KiPay ke kita),
 * supaya totalPaid = amount + fee tetap konsisten artinya dengan method lain:
 * "nominal yang harus benar-benar ditransfer/discan user".
 */
async function createQrisDeposit(userId: string, amount: number) {
  let trx;
  try {
    trx = await createKipayTransaction(amount, `Deposit ${userId}`);
  } catch (err) {
    if (err instanceof KipayUnavailableError) {
      logger.error({ err: err.message, userId, amount }, 'Gagal membuat tagihan QRIS KiPay');
      throw badRequest(
        'PAYMENT_GATEWAY_UNAVAILABLE',
        'Gateway pembayaran QRIS sedang tidak bisa diakses, coba lagi sebentar lagi.',
      );
    }
    throw err;
  }

  const deposit = await prisma.deposit.create({
    data: {
      userId,
      invoiceId: generateInvoiceId(),
      amount: trx.requestedAmount,
      fee: trx.uniqueCode,
      totalPaid: trx.amount,
      method: 'QRIS',
      status: DepositStatus.PENDING,
      paymentReference: trx.trxId,
      paymentPayload: JSON.stringify(trx.raw),
      qrPayload: trx.qrPayload,
      expiredAt: trx.expiresAt ?? new Date(Date.now() + env.DEPOSIT_EXPIRY_MINUTES * 60 * 1000),
    },
  });

  logger.info(
    { invoiceId: deposit.invoiceId, userId, trxId: trx.trxId, amount: trx.amount },
    'Deposit QRIS dibuat lewat KiPay',
  );
  return deposit;
}

/**
 * Fallback kalau webhook KiPay tidak pernah sampai -- sama alasannya dengan
 * worker rekonsiliasi TokoVoucher di reconcile.worker.ts. Dipanggil worker
 * secara berkala untuk deposit QRIS yang masih PENDING dan belum kedaluwarsa.
 */
export async function pollPendingKipayDeposits(): Promise<number> {
  if (!env.KIPAY_API_KEY) return 0;

  const pending = await prisma.deposit.findMany({
    where: {
      method: 'QRIS',
      status: DepositStatus.PENDING,
      paymentReference: { not: null },
    },
    take: 25,
    orderBy: { createdAt: 'asc' },
  });

  for (const deposit of pending) {
    try {
      const trx = await getKipayTransaction(deposit.paymentReference as string);
      if (trx.status === 'paid') {
        await markDepositPaid(deposit.invoiceId, trx.trxId, trx.raw);
      } else if (trx.status === 'expired') {
        await prisma.deposit.updateMany({
          where: { id: deposit.id, status: DepositStatus.PENDING },
          data: { status: DepositStatus.EXPIRED },
        });
      }
    } catch (err) {
      logger.error(
        { err, invoiceId: deposit.invoiceId },
        'Gagal polling status deposit QRIS ke KiPay',
      );
    }
  }

  return pending.length;
}

/** Kode unik 3 digit, cukup untuk membedakan tagihan yang berjalan bersamaan. */
function uniqueCode(seed: string): number {
  const base = Number(BigInt(`0x${Buffer.from(seed).toString('hex').slice(0, 8)}`));
  return (base + Date.now()) % 900;
}

/**
 * Menandai deposit lunas dan menambahkan saldo.
 *
 * Aman dipanggil berkali-kali: postingKey DEPOSIT:<id> memastikan saldo hanya
 * bertambah sekali walau webhook dikirim berulang, yang memang biasa terjadi
 * pada payment gateway.
 */
export async function markDepositPaid(
  invoiceId: string,
  paymentReference?: string,
  rawPayload?: unknown,
) {
  return prisma.$transaction(async (db) => {
    const deposit = await db.deposit.findUnique({ where: { invoiceId } });
    if (!deposit) throw notFound(`Deposit ${invoiceId} tidak ditemukan`);

    if (deposit.status === DepositStatus.PAID) {
      logger.info({ invoiceId }, 'Deposit sudah lunas, permintaan diabaikan');
      return deposit;
    }

    if (deposit.status === DepositStatus.EXPIRED) {
      // Pembayaran yang datang setelah tagihan kedaluwarsa tetap diterima --
      // uangnya sudah benar-benar masuk, menolaknya justru merugikan user.
      logger.warn({ invoiceId }, 'Deposit kedaluwarsa dibayar, tetap diproses');
    }

    await postMutation({
      db,
      userId: deposit.userId,
      type: LedgerType.DEPOSIT,
      amount: deposit.amount,
      description: `Deposit saldo ${deposit.invoiceId}`,
      postingKey: `DEPOSIT:${deposit.id}`,
      depositId: deposit.id,
    });

    const updated = await db.deposit.update({
      where: { id: deposit.id },
      data: {
        status: DepositStatus.PAID,
        paidAt: new Date(),
        paymentReference: paymentReference ?? deposit.paymentReference,
        paymentPayload: rawPayload ? JSON.stringify(rawPayload) : deposit.paymentPayload,
      },
    });

    logger.info(
      { invoiceId, userId: deposit.userId, amount: deposit.amount },
      'Deposit lunas, saldo ditambahkan',
    );
    return updated;
  });
}

export async function cancelDeposit(userId: string, invoiceId: string) {
  const deposit = await prisma.deposit.findUnique({ where: { invoiceId } });
  if (!deposit || deposit.userId !== userId) {
    throw notFound('Deposit tidak ditemukan');
  }
  if (deposit.status !== DepositStatus.PENDING) {
    throw conflict('DEPOSIT_NOT_PENDING', 'Deposit ini tidak bisa dibatalkan');
  }

  return prisma.deposit.update({
    where: { id: deposit.id },
    data: { status: DepositStatus.FAILED },
  });
}

/** Dipanggil worker untuk menutup tagihan yang lewat waktu. */
export async function expireStaleDeposits(): Promise<number> {
  const result = await prisma.deposit.updateMany({
    where: { status: DepositStatus.PENDING, expiredAt: { lt: new Date() } },
    data: { status: DepositStatus.EXPIRED },
  });

  if (result.count > 0) {
    logger.info({ count: result.count }, 'Deposit kedaluwarsa ditutup');
  }
  return result.count;
}

export async function listDeposits(
  userId: string,
  options: { limit: number; cursor?: string },
) {
  const rows = await prisma.deposit.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: options.limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      invoiceId: true,
      amount: true,
      fee: true,
      totalPaid: true,
      method: true,
      status: true,
      qrPayload: true,
      expiredAt: true,
      paidAt: true,
      createdAt: true,
    },
  });

  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;
  return {
    deposits: page,
    nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
  };
}
