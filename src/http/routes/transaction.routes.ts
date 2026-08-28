import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { BRANDS, Brand, TxStatus } from '../../domain/enums';
import * as txService from '../../modules/transactions/transaction.service';
import { asyncHandler, ok, readPagination, requireUser } from '../helpers';
import { authenticate } from '../middleware/auth.middleware';

export const transactionRouter = Router();

transactionRouter.use(authenticate);

/**
 * Pembatas laju di lapisan HTTP. Ini pelengkap, bukan pengganti, pemeriksaan
 * di fraud.service.ts -- yang ini menahan banjir request, yang itu menahan
 * pola penyalahgunaan yang dilihat dari data transaksi.
 */
const createLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? req.ip ?? 'anonymous',
  message: {
    success: false,
    error: {
      code: 'RATE_LIMITED',
      message: 'Terlalu banyak permintaan. Coba beberapa saat lagi.',
    },
  },
});

const brandSchema = z
  .string()
  .transform((v) => v.toUpperCase())
  .refine((v): v is Brand => (BRANDS as string[]).includes(v), {
    message: `brand harus salah satu dari: ${BRANDS.join(', ')}`,
  });

/**
 * Produk boleh disebut dengan dua cara: kodeProduk langsung, atau kombinasi
 * brand + nominal. Cara kedua membuat client tidak perlu tahu 193 kode produk
 * dan tetap benar meski katalog supplier berubah.
 */
const createSchema = z
  .object({
    targetNumber: z.string().min(8, 'Nomor tujuan wajib diisi'),
    brand: brandSchema.optional(),
    nominal: z.coerce.number().int().positive().optional(),
    kodeProduk: z.string().min(1).optional(),
  })
  .refine((v) => Boolean(v.kodeProduk) || (Boolean(v.brand) && v.nominal !== undefined), {
    message: 'Sertakan kodeProduk, atau kombinasi brand dan nominal',
  });

transactionRouter.post(
  '/',
  createLimiter,
  asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const body = createSchema.parse(req.body);

    // Header Idempotency-Key membuat client aman melakukan retry: percobaan
    // kedua mengembalikan transaksi yang sama, bukan membuat transaksi baru.
    const idempotencyKey = req.header('idempotency-key');

    const { transaction, reused } = await txService.createTopup({
      userId: user.id,
      targetNumber: body.targetNumber,
      ...(body.brand ? { brand: body.brand } : {}),
      ...(body.nominal !== undefined ? { nominal: body.nominal } : {}),
      ...(body.kodeProduk ? { kodeProduk: body.kodeProduk } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    ok(
      res,
      { ...txService.toPublicTransaction(transaction), reused },
      reused ? 200 : 201,
    );
  }),
);

const listQuerySchema = z.object({
  status: z
    .string()
    .transform((v) => v.toUpperCase())
    .refine((v) => Object.values(TxStatus).includes(v as TxStatus), {
      message: `status harus salah satu dari: ${Object.values(TxStatus).join(', ')}`,
    })
    .optional(),
});

transactionRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const { status } = listQuerySchema.parse(req.query);
    const pagination = readPagination(req);

    ok(
      res,
      await txService.listTransactions(user.id, {
        ...pagination,
        ...(status ? { status } : {}),
      }),
    );
  }),
);

/** Menerima id internal maupun refId, supaya client bebas menyimpan salah satu. */
transactionRouter.get(
  '/:ref',
  asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const tx = await txService.getTransaction(user.id, String(req.params['ref']));
    ok(res, txService.toPublicTransaction(tx));
  }),
);
