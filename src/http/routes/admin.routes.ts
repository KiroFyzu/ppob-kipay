import { Router } from 'express';
import { z } from 'zod';
import { LedgerType } from '../../domain/enums';
import { prisma } from '../../lib/prisma';
import { supplier } from '../../providers/tokovoucher';
import { markDepositPaid } from '../../modules/balance/deposit.service';
import { auditBalance, postMutation } from '../../modules/balance/ledger.service';
import { syncCatalogFromSupplier } from '../../modules/products/product.service';
import { blockTarget, unblockTarget } from '../../modules/transactions/fraud.service';
import { normalizePhone } from '../../utils/phone';
import { asyncHandler, ok, readPagination, requireUser } from '../helpers';
import { authenticate, requireAdmin } from '../middleware/auth.middleware';

export const adminRouter = Router();

adminRouter.use(authenticate, requireAdmin);

/** Saldo kita sendiri di TokoVoucher. Habisnya saldo ini menghentikan semua transaksi. */
adminRouter.get(
  '/supplier/balance',
  asyncHandler(async (_req, res) => {
    ok(res, await supplier.getBalance());
  }),
);

adminRouter.post(
  '/products/sync',
  asyncHandler(async (_req, res) => {
    ok(res, await syncCatalogFromSupplier());
  }),
);

/**
 * Konfirmasi pembayaran deposit secara manual. Dipakai selama belum ada
 * payment gateway: admin mencocokkan mutasi rekening, lalu memanggil ini.
 */
adminRouter.post(
  '/deposits/:invoiceId/confirm',
  asyncHandler(async (req, res) => {
    const admin = requireUser(req);
    const deposit = await markDepositPaid(
      String(req.params['invoiceId']),
      `manual-by-${admin.id}`,
    );
    ok(res, { invoiceId: deposit.invoiceId, status: deposit.status });
  }),
);

/**
 * Penyesuaian saldo manual, untuk kasus seperti kompensasi atau koreksi.
 * Setiap penyesuaian wajib menyertakan alasan dan tetap tercatat di ledger,
 * jadi tidak ada perubahan saldo yang tanpa jejak.
 */
const adjustSchema = z.object({
  userId: z.string().min(1),
  amount: z.coerce.number().int().refine((v) => v !== 0, 'Nominal tidak boleh nol'),
  reason: z.string().min(5, 'Sebutkan alasan penyesuaian'),
  allowNegative: z.boolean().default(false),
});

adminRouter.post(
  '/balance/adjust',
  asyncHandler(async (req, res) => {
    const admin = requireUser(req);
    const body = adjustSchema.parse(req.body);

    const result = await prisma.$transaction((db) =>
      postMutation({
        db,
        userId: body.userId,
        type: LedgerType.ADJUSTMENT,
        amount: body.amount,
        description: `Penyesuaian oleh admin: ${body.reason}`,
        postingKey: `ADJUSTMENT:${admin.id}:${Date.now()}`,
        allowNegative: body.allowNegative,
      }),
    );

    ok(res, result);
  }),
);

/** Membandingkan saldo tercatat dengan hasil hitung ulang seluruh ledger. */
adminRouter.get(
  '/balance/audit/:userId',
  asyncHandler(async (req, res) => {
    ok(res, await auditBalance(String(req.params['userId'])));
  }),
);

const blockSchema = z.object({
  number: z.string().min(8),
  reason: z.string().min(3),
});

adminRouter.post(
  '/blocked-targets',
  asyncHandler(async (req, res) => {
    const admin = requireUser(req);
    const body = blockSchema.parse(req.body);
    const blocked = await blockTarget(
      normalizePhone(body.number),
      body.reason,
      admin.id,
    );
    ok(res, blocked, 201);
  }),
);

adminRouter.delete(
  '/blocked-targets/:number',
  asyncHandler(async (req, res) => {
    await unblockTarget(normalizePhone(String(req.params['number'])));
    ok(res, { unblocked: true });
  }),
);

adminRouter.get(
  '/blocked-targets',
  asyncHandler(async (_req, res) => {
    ok(res, await prisma.blockedTarget.findMany({ orderBy: { createdAt: 'desc' } }));
  }),
);

/**
 * Transaksi yang butuh perhatian manusia: sudah ditandai macet oleh worker
 * karena terlalu lama tidak mendapat kepastian dari supplier.
 */
adminRouter.get(
  '/transactions/flagged',
  asyncHandler(async (req, res) => {
    const { limit } = readPagination(req);
    ok(
      res,
      await prisma.transaction.findMany({
        where: { flaggedReason: { not: null } },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
    );
  }),
);
