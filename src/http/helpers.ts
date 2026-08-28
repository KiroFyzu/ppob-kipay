import { NextFunction, Request, RequestHandler, Response } from 'express';
import { unauthorized } from '../lib/errors';
import { AuthUser } from './middleware/auth.middleware';

/**
 * Express 4 tidak menangkap rejection dari handler async, sehingga error di
 * dalamnya akan menggantungkan request tanpa respons. Semua route async harus
 * dibungkus di sini.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/**
 * Mengambil user yang sudah terautentikasi. Melempar kalau kosong, sehingga
 * handler tidak perlu menuliskan pengecekan null berulang kali.
 */
export function requireUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function ok(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ success: true, data });
}

/** Membaca parameter paginasi dengan batas atas yang aman. */
export function readPagination(req: Request): { limit: number; cursor?: string } {
  const raw = Number(req.query['limit']);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 100) : 20;
  const cursor = req.query['cursor'];
  return {
    limit,
    ...(typeof cursor === 'string' && cursor ? { cursor } : {}),
  };
}
