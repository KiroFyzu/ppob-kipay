import { randomBytes, timingSafeEqual } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { forbidden } from '../lib/errors';

/**
 * Perlindungan CSRF dengan pola double-submit cookie.
 *
 * Kenapa ini wajib ada di sisi web tapi tidak di API: API memakai header
 * Authorization yang harus disertakan client secara sadar, sedangkan halaman
 * web memakai cookie yang dikirim browser SECARA OTOMATIS ke setiap request.
 * Tanpa CSRF token, situs lain bisa memasang form tersembunyi yang mengirim
 * POST ke /topup, dan browser korban akan menyertakan cookie login-nya --
 * artinya saldo korban bisa dipakai tanpa dia sadari.
 *
 * Token disimpan di cookie yang boleh dibaca JavaScript, lalu harus dikirim
 * ulang sebagai field form. Situs lain tidak bisa membaca cookie milik domain
 * kita, jadi mereka tidak bisa menebak isinya.
 */

const CSRF_COOKIE = 'csrf_token';
const TOKEN_FIELD = '_csrf';

export function issueCsrfToken(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  let token = req.cookies?.[CSRF_COOKIE] as string | undefined;

  if (!token || token.length !== 64) {
    token = randomBytes(32).toString('hex');
    res.cookie(CSRF_COOKIE, token, {
      // Sengaja TIDAK httpOnly: nilainya memang perlu terbaca untuk disisipkan
      // ke form. Kerahasiaannya dijaga oleh same-origin policy, bukan flag ini.
      httpOnly: false,
      sameSite: 'strict',
      secure: env.NODE_ENV === 'production',
      maxAge: 12 * 60 * 60 * 1000,
    });
  }

  // Dipakai partial form untuk menyisipkan input tersembunyi.
  res.locals['csrfToken'] = token;
  next();
}

export function verifyCsrf(req: Request, _res: Response, next: NextFunction): void {
  const cookieToken = req.cookies?.[CSRF_COOKIE] as string | undefined;
  const bodyToken = (req.body as Record<string, unknown> | undefined)?.[TOKEN_FIELD];

  if (
    typeof cookieToken !== 'string' ||
    typeof bodyToken !== 'string' ||
    cookieToken.length !== bodyToken.length
  ) {
    next(forbidden('Sesi form tidak valid. Muat ulang halaman lalu coba lagi.'));
    return;
  }

  const a = Buffer.from(cookieToken);
  const b = Buffer.from(bodyToken);
  if (!timingSafeEqual(a, b)) {
    next(forbidden('Sesi form tidak valid. Muat ulang halaman lalu coba lagi.'));
    return;
  }

  next();
}
