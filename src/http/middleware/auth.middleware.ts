import { NextFunction, Request, Response } from 'express';
import { Role } from '../../domain/enums';
import { forbidden, unauthorized } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { resolveApiKey, verifyToken } from '../../modules/auth/auth.service';

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Menerima dua cara autentikasi:
 *   - Authorization: Bearer <jwt>   untuk aplikasi frontend
 *   - X-API-Key: sk_...             untuk integrasi server-to-server
 */
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const apiKey = req.header('x-api-key');
    if (apiKey) {
      const user = await resolveApiKey(apiKey);
      req.user = { id: user.id, email: user.email, role: user.role as Role };
      next();
      return;
    }

    const header = req.header('authorization');
    if (!header?.startsWith('Bearer ')) {
      throw unauthorized('Sertakan header Authorization: Bearer <token>');
    }

    const payload = verifyToken(header.slice(7).trim());

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, role: true, isActive: true },
    });

    if (!user) throw unauthorized('User tidak ditemukan');
    if (!user.isActive) throw forbidden('Akun dinonaktifkan');

    req.user = { id: user.id, email: user.email, role: user.role as Role };
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAdmin(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (req.user?.role !== Role.ADMIN) {
    next(forbidden('Endpoint ini hanya untuk admin'));
    return;
  }
  next();
}
