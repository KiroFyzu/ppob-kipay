import { Router } from 'express';
import { z } from 'zod';
import * as authService from '../../modules/auth/auth.service';
import { asyncHandler, ok, requireUser } from '../helpers';
import { accountLimiter, sourceLimiter } from '../rate-limits';
import { authenticate } from '../middleware/auth.middleware';

export const authRouter = Router();

/**
 * Dua lapis pembatas: ketat per akun, longgar per IP. Alasannya dijelaskan di
 * src/http/rate-limits.ts.
 */
const authLimiters = {
  handler: ((_req, res) => {
    res.status(429).json({
      success: false,
      error: {
        code: 'TOO_MANY_ATTEMPTS',
        message: 'Terlalu banyak percobaan. Coba lagi dalam 15 menit.',
      },
    });
  }) as Parameters<typeof accountLimiter>[0]['handler'],
};

const perAccount = accountLimiter(authLimiters);
const perSource = sourceLimiter(authLimiters);

const registerSchema = z.object({
  email: z.string().email('Format email tidak valid'),
  password: z
    .string()
    .min(8, 'Password minimal 8 karakter')
    .max(128, 'Password terlalu panjang'),
  name: z.string().min(2, 'Nama minimal 2 karakter').max(100),
  phone: z.string().optional(),
});

authRouter.post(
  '/register',
  perSource,
  perAccount,
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);
    ok(res, await authService.register(body), 201);
  }),
);

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, 'Password wajib diisi'),
});

authRouter.post(
  '/login',
  perSource,
  perAccount,
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    ok(res, await authService.login(email, password));
  }),
);

authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = requireUser(req);
    ok(res, user);
  }),
);

// --- API key --------------------------------------------------------------

const apiKeySchema = z.object({
  label: z.string().min(1, 'Label wajib diisi').max(60),
});

authRouter.post(
  '/api-keys',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const { label } = apiKeySchema.parse(req.body);
    const created = await authService.createApiKey(user.id, label);
    ok(
      res,
      {
        ...created,
        warning: 'Simpan key ini sekarang. Key tidak bisa ditampilkan lagi.',
      },
      201,
    );
  }),
);

authRouter.get(
  '/api-keys',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = requireUser(req);
    ok(res, await authService.listApiKeys(user.id));
  }),
);

authRouter.delete(
  '/api-keys/:id',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = requireUser(req);
    await authService.revokeApiKey(user.id, String(req.params['id']));
    ok(res, { revoked: true });
  }),
);

authRouter.post(
  '/api-keys/:id/regenerate',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const created = await authService.regenerateApiKey(user.id, String(req.params['id']));
    ok(
      res,
      {
        ...created,
        warning: 'Simpan key ini sekarang. Key lama sudah dicabut dan tidak bisa dipakai lagi.',
      },
      201,
    );
  }),
);
