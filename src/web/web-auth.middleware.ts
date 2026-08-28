import { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { Role } from '../domain/enums';
import { prisma } from '../lib/prisma';
import { verifyToken } from '../modules/auth/auth.service';

/**
 * Autentikasi untuk halaman web.
 *
 * Memakai JWT yang sama dengan API, tapi disimpan di cookie httpOnly alih-alih
 * dikirim lewat header. httpOnly berarti JavaScript tidak bisa membacanya,
 * sehingga satu celah XSS tidak langsung berubah menjadi pencurian sesi.
 *
 * Konsekuensinya cookie ikut terkirim otomatis di setiap request, jadi seluruh
 * form POST wajib melewati verifikasi CSRF -- lihat src/web/csrf.ts.
 */

export const SESSION_COOKIE = 'session';

export interface WebUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  balance: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      webUser?: WebUser;
    }
  }
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE);
}

/**
 * Memuat user kalau cookie sesinya valid, tapi tidak memblokir kalau tidak.
 * Dipasang di semua halaman supaya header bisa menampilkan saldo dan nama.
 */
export async function loadWebUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  res.locals['user'] = null;
  res.locals['currentPath'] = req.path;

  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (!token) {
    next();
    return;
  }

  try {
    const payload = verifyToken(token);
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        balance: true,
        isActive: true,
      },
    });

    if (user?.isActive) {
      const webUser: WebUser = {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role as Role,
        balance: user.balance,
      };
      req.webUser = webUser;
      res.locals['user'] = webUser;
    } else {
      clearSessionCookie(res);
    }
  } catch {
    // Token kedaluwarsa atau rusak: bersihkan dan lanjut sebagai tamu.
    clearSessionCookie(res);
  }

  next();
}

/** Mewajibkan login; kalau belum, alihkan ke halaman masuk. */
export function requireWebLogin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.webUser) {
    const target = encodeURIComponent(req.originalUrl);
    res.redirect(`/masuk?next=${target}`);
    return;
  }
  next();
}

export function requireWebAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.webUser?.role !== Role.ADMIN) {
    res.status(403).render('pages/error', {
      title: 'Akses ditolak',
      statusCode: 403,
      message: 'Halaman ini hanya untuk admin.',
    });
    return;
  }
  next();
}
