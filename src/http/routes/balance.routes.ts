import { Router } from 'express';
import { z } from 'zod';
import { notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import {
  DEPOSIT_METHODS,
  DepositMethod,
  cancelDeposit,
  createDeposit,
  listDeposits,
} from '../../modules/balance/deposit.service';
import { getLedgerHistory } from '../../modules/balance/ledger.service';
import { fetchKipayQrImage } from '../../providers/kipay/client';
import { KipayUnavailableError } from '../../providers/kipay/types';
import { asyncHandler, ok, readPagination, requireUser } from '../helpers';
import { authenticate } from '../middleware/auth.middleware';

export const balanceRouter = Router();

balanceRouter.use(authenticate);

balanceRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { balance: true },
    });
    ok(res, { balance: row.balance });
  }),
);

balanceRouter.get(
  '/history',
  asyncHandler(async (req, res) => {
    const user = requireUser(req);
    ok(res, await getLedgerHistory(user.id, readPagination(req)));
  }),
);

const depositSchema = z.object({
  amount: z.coerce.number().int().positive(),
  method: z
    .enum(DEPOSIT_METHODS)
    .default('MANUAL_TRANSFER' satisfies DepositMethod),
});

balanceRouter.post(
  '/deposits',
  asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const { amount, method } = depositSchema.parse(req.body);

    const deposit = await createDeposit({ userId: user.id, amount, method });

    ok(
      res,
      {
        invoiceId: deposit.invoiceId,
        amount: deposit.amount,
        fee: deposit.fee,
        /** Nominal inilah yang harus dibayar persis, termasuk kode uniknya. */
        totalPaid: deposit.totalPaid,
        method: deposit.method,
        status: deposit.status,
        expiredAt: deposit.expiredAt.toISOString(),
        // Hanya terisi untuk method QRIS.
        qrPayload: deposit.qrPayload,
      },
      201,
    );
  }),
);

/**
 * Proxy gambar QR dari KiPay. Diproxy (bukan diarahkan ke URL KiPay langsung)
 * supaya KIPAY_API_KEY tidak pernah dikirim ke browser -- lihat catatan di
 * providers/kipay/client.ts.
 */
balanceRouter.get(
  '/deposits/:invoiceId/qr.png',
  asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const deposit = await prisma.deposit.findUnique({
      where: { invoiceId: String(req.params['invoiceId']) },
    });
    if (!deposit || deposit.userId !== user.id) throw notFound('Deposit tidak ditemukan');
    if (deposit.method !== 'QRIS' || !deposit.paymentReference) {
      throw notFound('Deposit ini tidak punya QR');
    }

    try {
      const png = await fetchKipayQrImage(deposit.paymentReference);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'private, max-age=60');
      res.send(png);
    } catch (err) {
      if (err instanceof KipayUnavailableError) {
        res.status(502).json({
          success: false,
          error: { code: 'PAYMENT_GATEWAY_UNAVAILABLE', message: err.message },
        });
        return;
      }
      throw err;
    }
  }),
);

balanceRouter.get(
  '/deposits',
  asyncHandler(async (req, res) => {
    const user = requireUser(req);
    ok(res, await listDeposits(user.id, readPagination(req)));
  }),
);

balanceRouter.post(
  '/deposits/:invoiceId/cancel',
  asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const deposit = await cancelDeposit(user.id, String(req.params['invoiceId']));
    ok(res, { invoiceId: deposit.invoiceId, status: deposit.status });
  }),
);
