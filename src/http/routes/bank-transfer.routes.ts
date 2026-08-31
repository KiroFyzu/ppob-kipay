import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { TxStatus } from '../../domain/enums';
import * as btService from '../../modules/bank-transfer/bank-transfer.service';
import { asyncHandler, ok, readPagination, requireUser } from '../helpers';
import { authenticate } from '../middleware/auth.middleware';

export const bankTransferRouter = Router();

bankTransferRouter.use(authenticate);

/** Sama seperti pembatas di transaction.routes.ts. */
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

const createSchema = z.object({
  bankCode: z.string().min(1, 'bankCode wajib diisi'),
  targetNumber: z.string().min(6, 'Nomor rekening wajib diisi'),
  nominal: z.coerce.number().int().positive(),
});

bankTransferRouter.post(
  '/',
  createLimiter,
  asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const body = createSchema.parse(req.body);
    const idempotencyKey = req.header('idempotency-key');

    const { bankTransfer, reused } = await btService.createBankTransfer({
      userId: user.id,
      bankCode: body.bankCode,
      targetNumber: body.targetNumber,
      nominal: body.nominal,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    ok(
      res,
      { ...btService.toPublicBankTransfer(bankTransfer), reused },
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

bankTransferRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const { status } = listQuerySchema.parse(req.query);
    const pagination = readPagination(req);

    ok(
      res,
      await btService.listBankTransfers(user.id, {
        ...pagination,
        ...(status ? { status } : {}),
      }),
    );
  }),
);

/** Menerima id internal maupun refId, supaya client bebas menyimpan salah satu. */
bankTransferRouter.get(
  '/:ref',
  asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const bt = await btService.getBankTransfer(user.id, String(req.params['ref']));
    ok(res, btService.toPublicBankTransfer(bt));
  }),
);

/** Tombol "Coba lagi" untuk transfer bank yang nyangkut di PROCESSING. */
bankTransferRouter.post(
  '/:ref/retry',
  createLimiter,
  asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const bt = await btService.retryBankTransfer(user.id, String(req.params['ref']));
    ok(res, btService.toPublicBankTransfer(bt));
  }),
);
