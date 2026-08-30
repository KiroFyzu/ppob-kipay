import { Router } from 'express';
import { z } from 'zod';
import { LedgerType, TxStatus } from '../../domain/enums';
import { prisma } from '../../lib/prisma';
import { supplier } from '../../providers/tokovoucher';
import {
  refundStuckBankTransfer,
  toPublicBankTransfer,
} from '../../modules/bank-transfer/bank-transfer.service';
import { markDepositPaid } from '../../modules/balance/deposit.service';
import { auditBalance, postMutation } from '../../modules/balance/ledger.service';
import { syncCatalogFromSupplier } from '../../modules/products/product.service';
import { blockTarget, unblockTarget } from '../../modules/transactions/fraud.service';
import {
  refundStuckTransaction,
  toPublicTransaction,
} from '../../modules/transactions/transaction.service';
import { listUsers, setUserActive } from '../../modules/users/user.service';
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
 * Ringkasan angka untuk dashboard admin: jumlah produk/pengguna, transaksi
 * yang butuh tinjauan, dan keuntungan (sellPrice - basePrice, dijumlahkan
 * lewat aggregate) dari seluruh transaksi sukses -- e-wallet dan bank.
 */
adminRouter.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    const [productCount, userCount, flaggedCount, txProfit, btProfit] = await Promise.all([
      prisma.product.count({ where: { isActive: true } }),
      prisma.user.count(),
      prisma.transaction.count({ where: { flaggedReason: { not: null } } }),
      prisma.transaction.aggregate({
        where: { status: TxStatus.SUCCESS },
        _sum: { sellPrice: true, basePrice: true },
      }),
      prisma.bankTransfer.aggregate({
        where: { status: TxStatus.SUCCESS },
        _sum: { sellPrice: true, basePrice: true },
      }),
    ]);

    const totalProfit =
      (txProfit._sum.sellPrice ?? 0) -
      (txProfit._sum.basePrice ?? 0) +
      (btProfit._sum.sellPrice ?? 0) -
      (btProfit._sum.basePrice ?? 0);

    ok(res, { productCount, userCount, flaggedCount, totalProfit });
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

/**
 * Transaksi yang masih "Diproses" lintas user -- kandidat refund manual saat
 * macet lama tanpa kepastian dari supplier.
 */
adminRouter.get(
  '/transactions/processing',
  asyncHandler(async (req, res) => {
    const { limit } = readPagination(req);

    const [tx, bt] = await Promise.all([
      prisma.transaction.findMany({
        where: { status: TxStatus.PROCESSING },
        orderBy: { createdAt: 'asc' },
        take: limit,
        include: { user: { select: { id: true, email: true, name: true } } },
      }),
      prisma.bankTransfer.findMany({
        where: { status: TxStatus.PROCESSING },
        orderBy: { createdAt: 'asc' },
        take: limit,
        include: { user: { select: { id: true, email: true, name: true } } },
      }),
    ]);

    ok(res, {
      transactions: tx.map((t) => ({ ...toPublicTransaction(t), user: t.user })),
      bankTransfers: bt.map((b) => ({ ...toPublicBankTransfer(b), user: b.user })),
    });
  }),
);

/**
 * Refund manual untuk transaksi/transfer bank yang masih PROCESSING. Lihat
 * catatan di refundStuckTransaction() soal risikonya.
 */
adminRouter.post(
  '/transactions/:id/refund',
  asyncHandler(async (req, res) => {
    const admin = requireUser(req);
    ok(res, await refundStuckTransaction(String(req.params['id']), admin.id));
  }),
);

adminRouter.post(
  '/bank-transfers/:id/refund',
  asyncHandler(async (req, res) => {
    const admin = requireUser(req);
    ok(res, await refundStuckBankTransfer(String(req.params['id']), admin.id));
  }),
);

/**
 * Transaksi berhasil lintas user, digabung dari topup e-wallet dan transfer
 * bank -- sama seperti halaman "Detail Transaksi" di web, dipakai admin untuk
 * memantau transaksi yang benar-benar sukses terkirim.
 */
adminRouter.get(
  '/transactions/successful',
  asyncHandler(async (req, res) => {
    const { limit } = readPagination(req);

    const [tx, bt] = await Promise.all([
      prisma.transaction.findMany({
        where: { status: TxStatus.SUCCESS },
        orderBy: { completedAt: 'desc' },
        take: limit,
        include: { user: { select: { id: true, email: true, name: true } } },
      }),
      prisma.bankTransfer.findMany({
        where: { status: TxStatus.SUCCESS },
        orderBy: { completedAt: 'desc' },
        take: limit,
        include: { user: { select: { id: true, email: true, name: true } } },
      }),
    ]);

    const merged = [
      ...tx.map((t) => ({ ...toPublicTransaction(t), user: t.user })),
      ...bt.map((b) => ({ ...toPublicBankTransfer(b), user: b.user })),
    ]
      .sort(
        (a, b) =>
          new Date(b.completedAt ?? 0).getTime() - new Date(a.completedAt ?? 0).getTime(),
      )
      .slice(0, limit);

    ok(res, merged);
  }),
);

// --- Pengguna ---------------------------------------------------------------

adminRouter.get(
  '/users',
  asyncHandler(async (req, res) => {
    const { limit } = readPagination(req);
    ok(res, await listUsers({ limit }));
  }),
);

adminRouter.post(
  '/users/:id/activate',
  asyncHandler(async (req, res) => {
    const admin = requireUser(req);
    ok(res, await setUserActive(admin.id, String(req.params['id']), true));
  }),
);

adminRouter.post(
  '/users/:id/deactivate',
  asyncHandler(async (req, res) => {
    const admin = requireUser(req);
    ok(res, await setUserActive(admin.id, String(req.params['id']), false));
  }),
);
