import { Response, Router } from 'express';
import { accountLimiter, sourceLimiter } from '../http/rate-limits';
import { ZodError, z } from 'zod';
import { env } from '../config/env';
import { BANK_LABEL, BRANDS, Brand, DepositStatus, TxStatus } from '../domain/enums';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import * as authService from '../modules/auth/auth.service';
import * as bankTransferService from '../modules/bank-transfer/bank-transfer.service';
import * as depositService from '../modules/balance/deposit.service';
import { getLedgerHistory } from '../modules/balance/ledger.service';
import * as productService from '../modules/products/product.service';
import { blockTarget, unblockTarget } from '../modules/transactions/fraud.service';
import * as txService from '../modules/transactions/transaction.service';
import * as userService from '../modules/users/user.service';
import { fetchKipayQrImage } from '../providers/kipay/client';
import { KipayUnavailableError } from '../providers/kipay/types';
import { supplier } from '../providers/tokovoucher';
import { normalizePhone } from '../utils/phone';
import { verifyCsrf } from './csrf';
import {
  clearSessionCookie,
  requireWebAdmin,
  requireWebLogin,
  setSessionCookie,
} from './web-auth.middleware';

export const webRouter = Router();

/**
 * Halaman web server-rendered.
 *
 * Handler di sini memanggil service secara langsung, bukan lewat HTTP ke API
 * sendiri. Memanggil API sendiri berarti satu perjalanan jaringan tambahan,
 * penanganan error ganda, dan dua sumber kebenaran yang bisa berbeda perilaku.
 */

/**
 * Menerjemahkan error menjadi pesan yang layak dibaca pengguna, supaya halaman
 * form bisa dirender ulang lengkap dengan isian sebelumnya alih-alih melempar
 * pengguna ke halaman error.
 */
function toFormError(err: unknown): string | null {
  if (err instanceof AppError) return err.message;
  if (err instanceof ZodError) return err.issues[0]?.message ?? 'Data tidak valid';
  return null;
}

/**
 * Dua lapis pembatas: ketat per akun, longgar per IP. Alasannya dijelaskan di
 * src/http/rate-limits.ts.
 */
const authLimiterOptions = {
  handler: ((_req, res) => {
    res.status(429).render('pages/error', {
      title: 'Terlalu banyak percobaan',
      statusCode: 429,
      message: 'Terlalu banyak percobaan masuk. Coba lagi dalam 15 menit.',
    });
  }) as Parameters<typeof accountLimiter>[0]['handler'],
};

const perAccount = accountLimiter(authLimiterOptions);
const perSource = sourceLimiter(authLimiterOptions);

// ---------------------------------------------------------------------------
// Beranda dan katalog
// ---------------------------------------------------------------------------

/**
 * Brand dipilih lewat query param, bukan JavaScript, supaya halaman tetap
 * berfungsi penuh tanpa JS. Skrip di public/js/app.js hanya mempercepatnya.
 */
webRouter.get('/', async (req, res, next) => {
  try {
    const brands = await productService.listBrands();

    const requested = String(req.query['brand'] ?? '').toUpperCase();
    const selectedBrand = (BRANDS as string[]).includes(requested)
      ? (requested as Brand)
      : ((brands[0]?.brand as Brand) ?? null);

    const products = selectedBrand
      ? await productService.listProducts({ brand: selectedBrand })
      : [];

    res.render('pages/home', {
      title: 'Top Up E-Wallet',
      brands,
      selectedBrand,
      products,
      error: req.query['error'] ?? null,
    });
  } catch (err) {
    next(err);
  }
});

webRouter.get('/docs', (_req, res) => {
  res.render('pages/docs', { title: 'Dokumentasi API' });
});

// ---------------------------------------------------------------------------
// Autentikasi
// ---------------------------------------------------------------------------

webRouter.get('/masuk', (req, res) => {
  if (req.webUser) {
    res.redirect('/dasbor');
    return;
  }
  res.render('pages/login', {
    title: 'Masuk',
    error: null,
    email: '',
    next: String(req.query['next'] ?? ''),
  });
});

const loginSchema = z.object({
  email: z.string().email('Format email tidak valid'),
  password: z.string().min(1, 'Password wajib diisi'),
  next: z.string().optional(),
});

webRouter.post('/masuk', perSource, perAccount, verifyCsrf, async (req, res, next) => {
  const body = req.body as Record<string, string>;
  try {
    const input = loginSchema.parse(body);
    const { token } = await authService.login(input.email, input.password);
    setSessionCookie(res, token);

    // Hanya menerima path relatif. Menerima URL penuh membuat halaman ini bisa
    // dipakai mengarahkan korban ke situs lain setelah login.
    const target =
      input.next && input.next.startsWith('/') && !input.next.startsWith('//')
        ? input.next
        : '/dasbor';
    res.redirect(target);
  } catch (err) {
    const message = toFormError(err);
    if (!message) {
      next(err);
      return;
    }
    res.status(400).render('pages/login', {
      title: 'Masuk',
      error: message,
      email: body['email'] ?? '',
      next: body['next'] ?? '',
    });
  }
});

webRouter.get('/daftar', (req, res) => {
  if (req.webUser) {
    res.redirect('/dasbor');
    return;
  }
  res.render('pages/register', {
    title: 'Daftar',
    error: null,
    values: { name: '', email: '' },
  });
});

const registerSchema = z.object({
  name: z.string().min(2, 'Nama minimal 2 karakter').max(100),
  email: z.string().email('Format email tidak valid'),
  password: z.string().min(8, 'Password minimal 8 karakter').max(128),
});

webRouter.post('/daftar', perSource, perAccount, verifyCsrf, async (req, res, next) => {
  const body = req.body as Record<string, string>;
  try {
    const input = registerSchema.parse(body);
    const { token } = await authService.register(input);
    setSessionCookie(res, token);
    res.redirect('/dasbor');
  } catch (err) {
    const message = toFormError(err);
    if (!message) {
      next(err);
      return;
    }
    res.status(400).render('pages/register', {
      title: 'Daftar',
      error: message,
      values: { name: body['name'] ?? '', email: body['email'] ?? '' },
    });
  }
});

webRouter.post('/keluar', verifyCsrf, (_req, res) => {
  clearSessionCookie(res);
  res.redirect('/');
});

// ---------------------------------------------------------------------------
// Transaksi
// ---------------------------------------------------------------------------

const topupSchema = z.object({
  brand: z
    .string()
    .transform((v) => v.toUpperCase())
    .refine((v): v is Brand => (BRANDS as string[]).includes(v), 'Brand tidak dikenal'),
  nominal: z.coerce.number().int().positive('Pilih nominal terlebih dahulu'),
  targetNumber: z.string().min(8, 'Nomor tujuan wajib diisi'),
});

webRouter.post('/topup', requireWebLogin, verifyCsrf, async (req, res, next) => {
  const body = req.body as Record<string, string>;
  try {
    const input = topupSchema.parse(body);
    const user = req.webUser!;

    const { transaction } = await txService.createTopup({
      userId: user.id,
      brand: input.brand,
      nominal: input.nominal,
      targetNumber: input.targetNumber,
    });

    res.redirect(`/transaksi/${transaction.refId}`);
  } catch (err) {
    const message = toFormError(err);
    if (!message) {
      next(err);
      return;
    }

    // Render ulang beranda dengan pilihan pengguna tetap terisi, supaya tidak
    // perlu mengulang dari awal hanya karena satu kesalahan.
    try {
      const brands = await productService.listBrands();
      const brandParam = String(body['brand'] ?? '').toUpperCase();
      const selectedBrand = (BRANDS as string[]).includes(brandParam)
        ? (brandParam as Brand)
        : ((brands[0]?.brand as Brand) ?? null);

      res.status(400).render('pages/home', {
        title: 'Top Up E-Wallet',
        brands,
        selectedBrand,
        products: selectedBrand
          ? await productService.listProducts({ brand: selectedBrand })
          : [],
        error: message,
        values: {
          nominal: body['nominal'] ?? '',
          targetNumber: body['targetNumber'] ?? '',
        },
      });
    } catch (renderErr) {
      next(renderErr);
    }
  }
});

/**
 * "Riwayat Transaksi" dan "Detail Transaksi" menggabungkan dua sumber yang
 * berbeda modelnya di database -- Transaction (topup e-wallet) dan
 * BankTransfer (transfer bank) -- supaya user punya SATU riwayat, bukan dua
 * halaman terpisah yang gampang bikin bingung ("transaksiku ke mana?").
 * toPublicTransaction()/toPublicBankTransfer() masing-masing sudah menambah
 * field `kind` untuk membedakannya di template.
 */
async function listCombinedHistory(
  userId: string,
  options: { limit: number; status?: string },
) {
  const [tx, bt] = await Promise.all([
    txService.listTransactions(userId, options),
    bankTransferService.listBankTransfers(userId, options),
  ]);

  return [...tx.transactions, ...bt.bankTransfers]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, options.limit);
}

async function getCombinedTransaction(userId: string, ref: string) {
  try {
    return txService.toPublicTransaction(await txService.getTransaction(userId, ref));
  } catch (err) {
    if (!(err instanceof AppError) || err.statusCode !== 404) throw err;
  }
  return bankTransferService.toPublicBankTransfer(
    await bankTransferService.getBankTransfer(userId, ref),
  );
}

webRouter.get('/transaksi', requireWebLogin, async (req, res, next) => {
  try {
    const user = req.webUser!;
    const statusParam = String(req.query['status'] ?? '').toUpperCase();
    const status = Object.values(TxStatus).includes(statusParam as TxStatus)
      ? statusParam
      : undefined;

    const transactions = await listCombinedHistory(user.id, {
      limit: 25,
      ...(status ? { status } : {}),
    });

    res.render('pages/transactions', {
      title: 'Riwayat Transaksi',
      transactions,
      statuses: Object.values(TxStatus),
      activeStatus: status ?? null,
    });
  } catch (err) {
    next(err);
  }
});

webRouter.get('/transaksi/:ref', requireWebLogin, async (req, res, next) => {
  try {
    const user = req.webUser!;
    const tx = await getCombinedTransaction(user.id, String(req.params['ref']));

    res.render('pages/transaction-detail', {
      title: `Transaksi ${tx.refId}`,
      tx,
      // Halaman menyegarkan diri sendiri selama status belum final, memakai
      // meta refresh supaya tetap bekerja tanpa JavaScript.
      autoRefresh: tx.status === TxStatus.PENDING || tx.status === TxStatus.PROCESSING,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Transfer Bank (TokoVoucher)
// ---------------------------------------------------------------------------

async function renderBankTransferPage(
  res: Response,
  user: { id: string } | undefined,
  extra: { error?: string; values?: { bankCode?: string; targetNumber?: string; nominal?: string } } = {},
  status = 200,
) {
  const list = user
    ? await bankTransferService.listBankTransfers(user.id, { limit: 10 })
    : { bankTransfers: [] };

  res.status(status).render('pages/bank-transfer', {
    title: 'Transfer Bank',
    banks: Object.entries(BANK_LABEL).map(([code, label]) => ({ code, label })),
    minAmount: env.BANK_TRANSFER_MIN_AMOUNT,
    maxAmount: env.BANK_TRANSFER_MAX_AMOUNT,
    bankTransfers: list.bankTransfers,
    error: extra.error ?? null,
    values: extra.values ?? null,
  });
}

webRouter.get('/transfer-bank', async (req, res, next) => {
  try {
    await renderBankTransferPage(res, req.webUser);
  } catch (err) {
    next(err);
  }
});

const bankTransferSchema = z.object({
  bankCode: z.string().min(1, 'Pilih bank tujuan'),
  targetNumber: z.string().min(6, 'Nomor rekening wajib diisi'),
  nominal: z.coerce.number().int().positive('Nominal tidak valid'),
});

webRouter.post('/transfer-bank', requireWebLogin, verifyCsrf, async (req, res, next) => {
  const body = req.body as Record<string, string>;
  try {
    const input = bankTransferSchema.parse(body);
    const user = req.webUser!;

    const { bankTransfer } = await bankTransferService.createBankTransfer({
      userId: user.id,
      bankCode: input.bankCode,
      targetNumber: input.targetNumber,
      nominal: input.nominal,
    });

    res.redirect(`/transaksi/${bankTransfer.refId}`);
  } catch (err) {
    const message = toFormError(err);
    if (!message) {
      next(err);
      return;
    }

    try {
      await renderBankTransferPage(
        res,
        req.webUser,
        {
          error: message,
          values: {
            bankCode: body['bankCode'] ?? '',
            targetNumber: body['targetNumber'] ?? '',
            nominal: body['nominal'] ?? '',
          },
        },
        400,
      );
    } catch (renderErr) {
      next(renderErr);
    }
  }
});

// Detail transfer bank sekarang dilayani oleh /transaksi/:ref (satu halaman
// struk untuk e-wallet maupun bank), supaya tidak ada dua template yang
// gampang tidak sinkron. Redirect ini menjaga tautan lama tetap bekerja.
webRouter.get('/transfer-bank/:ref', requireWebLogin, (req, res) => {
  res.redirect(`/transaksi/${req.params['ref']}`);
});

// ---------------------------------------------------------------------------
// Akun & API key
// ---------------------------------------------------------------------------

/**
 * Render dipanggil langsung (bukan redirect) setelah aksi yang menghasilkan
 * raw key baru, supaya nilainya masih ada untuk ditampilkan sekali. Setelah
 * halaman ini dimuat ulang lewat GET biasa, raw key sudah tidak bisa dilihat
 * lagi -- hanya prefix-nya yang tersimpan.
 */
async function renderAccountPage(
  res: Response,
  userId: string,
  extra: { newKey?: Awaited<ReturnType<typeof authService.createApiKey>>; error?: string } = {},
) {
  const apiKeys = await authService.listApiKeys(userId);
  res.render('pages/account', {
    title: 'Akun & API Key',
    apiKeys,
    newKey: extra.newKey ?? null,
    error: extra.error ?? null,
  });
}

webRouter.get('/akun', requireWebLogin, async (req, res, next) => {
  try {
    await renderAccountPage(res, req.webUser!.id);
  } catch (err) {
    next(err);
  }
});

const apiKeyLabelSchema = z.object({
  label: z.string().min(1, 'Label wajib diisi').max(60),
});

webRouter.post('/akun/api-keys', requireWebLogin, verifyCsrf, async (req, res, next) => {
  try {
    const user = req.webUser!;
    const input = apiKeyLabelSchema.parse(req.body);
    const newKey = await authService.createApiKey(user.id, input.label);
    await renderAccountPage(res, user.id, { newKey });
  } catch (err) {
    const message = toFormError(err);
    if (!message) {
      next(err);
      return;
    }
    try {
      await renderAccountPage(res, req.webUser!.id, { error: message });
    } catch (renderErr) {
      next(renderErr);
    }
  }
});

webRouter.post(
  '/akun/api-keys/:id/regenerate',
  requireWebLogin,
  verifyCsrf,
  async (req, res, next) => {
    try {
      const user = req.webUser!;
      const newKey = await authService.regenerateApiKey(user.id, String(req.params['id']));
      await renderAccountPage(res, user.id, { newKey });
    } catch (err) {
      const message = toFormError(err);
      if (!message) {
        next(err);
        return;
      }
      try {
        await renderAccountPage(res, req.webUser!.id, { error: message });
      } catch (renderErr) {
        next(renderErr);
      }
    }
  },
);

webRouter.post('/akun/api-keys/:id/cabut', requireWebLogin, verifyCsrf, async (req, res, next) => {
  try {
    const user = req.webUser!;
    await authService.revokeApiKey(user.id, String(req.params['id']));
    res.redirect('/akun');
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Dasbor dan saldo
// ---------------------------------------------------------------------------

webRouter.get('/dasbor', requireWebLogin, async (req, res, next) => {
  try {
    const user = req.webUser!;

    const [recent, txCounts, btCounts] = await Promise.all([
      listCombinedHistory(user.id, { limit: 5 }),
      prisma.transaction.groupBy({
        by: ['status'],
        where: { userId: user.id },
        _count: { _all: true },
      }),
      prisma.bankTransfer.groupBy({
        by: ['status'],
        where: { userId: user.id },
        _count: { _all: true },
      }),
    ]);

    const summary: Record<string, number> = {};
    for (const row of [...txCounts, ...btCounts]) {
      summary[row.status] = (summary[row.status] ?? 0) + row._count._all;
    }

    res.render('pages/dashboard', {
      title: 'Dasbor',
      recent,
      summary,
      totalTransactions: Object.values(summary).reduce((sum, n) => sum + n, 0),
    });
  } catch (err) {
    next(err);
  }
});

webRouter.get('/saldo', requireWebLogin, async (req, res, next) => {
  try {
    const user = req.webUser!;
    const [history, deposits] = await Promise.all([
      getLedgerHistory(user.id, { limit: 25 }),
      depositService.listDeposits(user.id, { limit: 10 }),
    ]);

    res.render('pages/balance', {
      title: 'Saldo',
      history: history.entries,
      deposits: deposits.deposits,
      methods: depositService.DEPOSIT_METHODS,
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

const depositSchema = z.object({
  amount: z.coerce.number().int().positive('Nominal deposit tidak valid'),
  method: z.enum(depositService.DEPOSIT_METHODS),
});

webRouter.post('/saldo/deposit', requireWebLogin, verifyCsrf, async (req, res, next) => {
  try {
    const user = req.webUser!;
    const input = depositSchema.parse(req.body);

    const deposit = await depositService.createDeposit({
      userId: user.id,
      amount: input.amount,
      method: input.method,
    });

    res.redirect(`/saldo/deposit/${deposit.invoiceId}`);
  } catch (err) {
    const message = toFormError(err);
    if (!message) {
      next(err);
      return;
    }
    try {
      const user = req.webUser!;
      const [history, deposits] = await Promise.all([
        getLedgerHistory(user.id, { limit: 25 }),
        depositService.listDeposits(user.id, { limit: 10 }),
      ]);
      res.status(400).render('pages/balance', {
        title: 'Saldo',
        history: history.entries,
        deposits: deposits.deposits,
        methods: depositService.DEPOSIT_METHODS,
        error: message,
      });
    } catch (renderErr) {
      next(renderErr);
    }
  }
});

webRouter.get('/saldo/deposit/:invoiceId', requireWebLogin, async (req, res, next) => {
  try {
    const user = req.webUser!;
    const deposit = await prisma.deposit.findFirst({
      where: { invoiceId: String(req.params['invoiceId']), userId: user.id },
    });

    if (!deposit) {
      res.status(404).render('pages/error', {
        title: 'Tidak ditemukan',
        statusCode: 404,
        message: 'Tagihan deposit tidak ditemukan.',
      });
      return;
    }

    res.render('pages/deposit-detail', {
      title: `Deposit ${deposit.invoiceId}`,
      deposit,
      autoRefresh: deposit.status === DepositStatus.PENDING,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Proxy gambar QR KiPay untuk halaman web -- terpisah dari
 * GET /api/v1/balance/deposits/:invoiceId/qr.png karena route API itu
 * diautentikasi lewat Bearer/API key, bukan cookie sesi yang dipakai halaman
 * web ini. Ownership tetap dicek (userId harus cocok) sebelum memanggil KiPay.
 */
webRouter.get('/saldo/deposit/:invoiceId/qr.png', requireWebLogin, async (req, res, next) => {
  try {
    const user = req.webUser!;
    const deposit = await prisma.deposit.findFirst({
      where: { invoiceId: String(req.params['invoiceId']), userId: user.id },
    });

    if (!deposit || deposit.method !== 'QRIS' || !deposit.paymentReference) {
      res.status(404).end();
      return;
    }

    const png = await fetchKipayQrImage(deposit.paymentReference);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.send(png);
  } catch (err) {
    if (err instanceof KipayUnavailableError) {
      logger.error({ err: err.message }, 'Gagal mengambil QR KiPay untuk halaman web');
      res.status(502).end();
      return;
    }
    next(err);
  }
});

webRouter.post(
  '/saldo/deposit/:invoiceId/batal',
  requireWebLogin,
  verifyCsrf,
  async (req, res, next) => {
    try {
      const user = req.webUser!;
      await depositService.cancelDeposit(user.id, String(req.params['invoiceId']));
      res.redirect('/saldo');
    } catch (err) {
      const message = toFormError(err);
      if (!message) {
        next(err);
        return;
      }
      res.status(400).render('pages/error', {
        title: 'Gagal membatalkan',
        statusCode: 400,
        message,
      });
    }
  },
);

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

webRouter.get('/admin', requireWebLogin, requireWebAdmin, async (req, res, next) => {
  try {
    const [
      pendingDeposits,
      blocked,
      flagged,
      productCount,
      userCount,
      users,
      successTx,
      successBt,
      processingTx,
      processingBt,
      txProfit,
      btProfit,
    ] = await Promise.all([
      prisma.deposit.findMany({
        where: { status: DepositStatus.PENDING },
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: { user: { select: { email: true, name: true } } },
      }),
      prisma.blockedTarget.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
      prisma.transaction.findMany({
        where: { flaggedReason: { not: null } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      prisma.product.count({ where: { isActive: true } }),
      prisma.user.count(),
      userService.listUsers({ limit: 50 }),
      prisma.transaction.findMany({
        where: { status: TxStatus.SUCCESS },
        orderBy: { completedAt: 'desc' },
        take: 15,
        include: { user: { select: { email: true, name: true } } },
      }),
      prisma.bankTransfer.findMany({
        where: { status: TxStatus.SUCCESS },
        orderBy: { completedAt: 'desc' },
        take: 15,
        include: { user: { select: { email: true, name: true } } },
      }),
      prisma.transaction.findMany({
        where: { status: TxStatus.PROCESSING },
        orderBy: { createdAt: 'asc' },
        take: 30,
        include: { user: { select: { email: true, name: true } } },
      }),
      prisma.bankTransfer.findMany({
        where: { status: TxStatus.PROCESSING },
        orderBy: { createdAt: 'asc' },
        take: 30,
        include: { user: { select: { email: true, name: true } } },
      }),
      // Keuntungan = sellPrice - basePrice, dijumlahkan lewat aggregate
      // (bukan diambil semua baris lalu dijumlahkan di Node) supaya tetap
      // murah walau transaksi sukses sudah puluhan ribu baris.
      prisma.transaction.aggregate({
        where: { status: TxStatus.SUCCESS },
        _sum: { sellPrice: true, basePrice: true },
      }),
      prisma.bankTransfer.aggregate({
        where: { status: TxStatus.SUCCESS },
        _sum: { sellPrice: true, basePrice: true },
      }),
    ]);

    // Saldo supplier tidak boleh menjatuhkan seluruh halaman kalau API-nya
    // sedang bermasalah -- sisanya masih berguna.
    let supplierBalance: number | null = null;
    let supplierError: string | null = null;
    try {
      supplierBalance = (await supplier.getBalance()).balance;
    } catch (err) {
      supplierError = err instanceof Error ? err.message : 'Tidak dapat dihubungi';
    }

    const successfulTransactions = [
      ...successTx.map((t) => ({ ...txService.toPublicTransaction(t), user: t.user })),
      ...successBt.map((b) => ({ ...bankTransferService.toPublicBankTransfer(b), user: b.user })),
    ]
      .sort(
        (a, b) =>
          new Date(b.completedAt ?? 0).getTime() - new Date(a.completedAt ?? 0).getTime(),
      )
      .slice(0, 15);

    const processingTransactions = [
      ...processingTx.map((t) => ({
        ...txService.toPublicTransaction(t),
        user: t.user,
        refundAction: `/admin/transaksi/${t.id}/refund`,
      })),
      ...processingBt.map((b) => ({
        ...bankTransferService.toPublicBankTransfer(b),
        user: b.user,
        refundAction: `/admin/transfer-bank/${b.id}/refund`,
      })),
    ].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    const totalProfit =
      (txProfit._sum.sellPrice ?? 0) -
      (txProfit._sum.basePrice ?? 0) +
      (btProfit._sum.sellPrice ?? 0) -
      (btProfit._sum.basePrice ?? 0);

    res.render('pages/admin', {
      title: 'Panel Admin',
      pendingDeposits,
      blocked,
      flagged,
      productCount,
      userCount,
      users,
      successfulTransactions,
      processingTransactions,
      totalProfit,
      supplierBalance,
      supplierError,
      currentAdminId: req.webUser!.id,
      notice: null,
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

webRouter.post(
  '/admin/users/:id/aktifkan',
  requireWebLogin,
  requireWebAdmin,
  verifyCsrf,
  async (req, res, next) => {
    try {
      const admin = req.webUser!;
      await userService.setUserActive(admin.id, String(req.params['id']), true);
      res.redirect('/admin');
    } catch (err) {
      next(err);
    }
  },
);

webRouter.post(
  '/admin/users/:id/nonaktifkan',
  requireWebLogin,
  requireWebAdmin,
  verifyCsrf,
  async (req, res, next) => {
    try {
      const admin = req.webUser!;
      await userService.setUserActive(admin.id, String(req.params['id']), false);
      res.redirect('/admin');
    } catch (err) {
      next(err);
    }
  },
);

webRouter.post(
  '/admin/transaksi/:id/refund',
  requireWebLogin,
  requireWebAdmin,
  verifyCsrf,
  async (req, res, next) => {
    try {
      const admin = req.webUser!;
      await txService.refundStuckTransaction(String(req.params['id']), admin.id);
      res.redirect('/admin');
    } catch (err) {
      logger.error({ err }, 'Gagal refund manual transaksi dari panel admin');
      next(err);
    }
  },
);

webRouter.post(
  '/admin/transfer-bank/:id/refund',
  requireWebLogin,
  requireWebAdmin,
  verifyCsrf,
  async (req, res, next) => {
    try {
      const admin = req.webUser!;
      await bankTransferService.refundStuckBankTransfer(String(req.params['id']), admin.id);
      res.redirect('/admin');
    } catch (err) {
      logger.error({ err }, 'Gagal refund manual transfer bank dari panel admin');
      next(err);
    }
  },
);

webRouter.post(
  '/admin/deposit/:invoiceId/konfirmasi',
  requireWebLogin,
  requireWebAdmin,
  verifyCsrf,
  async (req, res, next) => {
    try {
      const admin = req.webUser!;
      await depositService.markDepositPaid(
        String(req.params['invoiceId']),
        `manual-by-${admin.id}`,
      );
      res.redirect('/admin');
    } catch (err) {
      logger.error({ err }, 'Gagal konfirmasi deposit dari panel admin');
      next(err);
    }
  },
);

const blockSchema = z.object({
  number: z.string().min(8, 'Nomor wajib diisi'),
  reason: z.string().min(3, 'Sebutkan alasan pemblokiran'),
});

webRouter.post(
  '/admin/blokir',
  requireWebLogin,
  requireWebAdmin,
  verifyCsrf,
  async (req, res, next) => {
    try {
      const admin = req.webUser!;
      const input = blockSchema.parse(req.body);
      await blockTarget(normalizePhone(input.number), input.reason, admin.id);
      res.redirect('/admin');
    } catch (err) {
      const message = toFormError(err);
      if (!message) {
        next(err);
        return;
      }
      res.status(400).render('pages/error', {
        title: 'Gagal memblokir',
        statusCode: 400,
        message,
      });
    }
  },
);

webRouter.post(
  '/admin/blokir/hapus',
  requireWebLogin,
  requireWebAdmin,
  verifyCsrf,
  async (req, res, next) => {
    try {
      await unblockTarget(String((req.body as Record<string, string>)['number']));
      res.redirect('/admin');
    } catch (err) {
      next(err);
    }
  },
);
