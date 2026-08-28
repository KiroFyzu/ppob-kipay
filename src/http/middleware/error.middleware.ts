import { Prisma } from '@prisma/client';
import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { env } from '../../config/env';
import { AppError } from '../../lib/errors';
import { logger } from '../../lib/logger';

/**
 * Satu-satunya tempat error diterjemahkan menjadi respons.
 *
 * Aplikasi ini melayani dua jenis klien dari kode yang sama: API yang
 * mengharapkan JSON, dan halaman web yang mengharapkan HTML. Jalur /api selalu
 * mendapat JSON; sisanya mendapat halaman error, kecuali klien secara eksplisit
 * meminta JSON.
 *
 * Bentuk respons JSON selalu:
 *   { "success": false, "error": { "code": "...", "message": "...", "details": ... } }
 */

function wantsHtml(req: Request): boolean {
  if (req.path.startsWith('/api/')) return false;
  return req.accepts(['html', 'json']) === 'html';
}

function renderError(
  res: Response,
  statusCode: number,
  title: string,
  message: string,
): void {
  res.status(statusCode).render('pages/error', { title, statusCode, message });
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const html = wantsHtml(req);

  if (err instanceof AppError) {
    // 4xx adalah kesalahan pemakaian, bukan kerusakan sistem, jadi dicatat
    // sebagai warn agar tidak membanjiri alarm error.
    logger.warn(
      { code: err.code, path: req.path, statusCode: err.statusCode },
      err.message,
    );

    if (html) {
      renderError(res, err.statusCode, 'Permintaan gagal', err.message);
      return;
    }

    res.status(err.statusCode).json({
      success: false,
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  if (err instanceof ZodError) {
    const first = err.issues[0]?.message ?? 'Data yang dikirim tidak valid';

    if (html) {
      renderError(res, 400, 'Data tidak valid', first);
      return;
    }

    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Data yang dikirim tidak valid',
        details: err.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      },
    });
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      if (html) {
        renderError(res, 409, 'Data sudah ada', 'Data yang kamu kirim sudah terdaftar.');
        return;
      }
      res.status(409).json({
        success: false,
        error: { code: 'DUPLICATE', message: 'Data sudah ada' },
      });
      return;
    }
    if (err.code === 'P2025') {
      if (html) {
        renderError(res, 404, 'Tidak ditemukan', 'Data yang dicari tidak ditemukan.');
        return;
      }
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Data tidak ditemukan' },
      });
      return;
    }
  }

  // Sisanya adalah bug. Detailnya dicatat lengkap di log, tapi tidak pernah
  // dikirim ke klien -- stack trace bisa membocorkan struktur internal.
  logger.error({ err, path: req.path, method: req.method }, 'Unhandled error');

  if (html) {
    renderError(
      res,
      500,
      'Terjadi kesalahan',
      'Ada gangguan pada server kami. Coba lagi beberapa saat lagi.',
    );
    return;
  }

  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Terjadi kesalahan pada server',
      ...(env.NODE_ENV === 'development' && err instanceof Error
        ? { details: err.message }
        : {}),
    },
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  if (wantsHtml(req)) {
    res.status(404).render('pages/error', {
      title: 'Halaman tidak ditemukan',
      statusCode: 404,
      message: 'Halaman yang kamu cari tidak ada atau sudah dipindahkan.',
    });
    return;
  }

  res.status(404).json({
    success: false,
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: `Endpoint ${req.method} ${req.path} tidak ditemukan`,
    },
  });
}
