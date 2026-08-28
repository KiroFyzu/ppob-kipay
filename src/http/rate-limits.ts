import { RequestHandler } from 'express';
import rateLimit, { Options } from 'express-rate-limit';

/**
 * Pembatas laju untuk endpoint autentikasi.
 *
 * Dibuat dua lapis, karena membatasi hanya per-IP punya kelemahan serius di
 * Indonesia: operator seluler menempatkan banyak pelanggan di balik satu IP
 * publik (CGNAT). Batas ketat per-IP berarti beberapa percobaan login yang
 * gagal dari satu orang bisa mengunci ratusan pengguna lain yang kebetulan
 * memakai operator yang sama.
 *
 * Karena itu:
 *   - Lapis akun  : dikunci ke alamat email, ketat. Inilah yang benar-benar
 *                   menahan penebakan password, dan tetap bekerja walau
 *                   penyerang berganti-ganti IP.
 *   - Lapis sumber: dikunci ke IP, longgar. Tugasnya hanya menahan banjir
 *                   permintaan, bukan menebak-nebak siapa penggunanya.
 */

const shared: Partial<Options> = {
  windowMs: 15 * 60 * 1000,
  standardHeaders: true,
  legacyHeaders: false,
};

export interface AuthLimiterOptions {
  /** Dipanggil saat batas terlampaui, untuk membalas JSON atau HTML. */
  handler: Options['handler'];
}

/**
 * Batas per akun. Kunci diambil dari email di body, sehingga satu akun tidak
 * bisa diserang berapa pun jumlah IP yang dipakai penyerang.
 */
export function accountLimiter({ handler }: AuthLimiterOptions): RequestHandler {
  return rateLimit({
    ...shared,
    limit: 10,
    handler,
    keyGenerator: (req) => {
      const email = (req.body as Record<string, unknown> | undefined)?.['email'];
      return typeof email === 'string' ? `akun:${email.toLowerCase().trim()}` : 'akun:-';
    },
    // Permintaan tanpa email tidak punya akun untuk dilindungi; biarkan lapis
    // IP yang menanganinya.
    skip: (req) => typeof (req.body as Record<string, unknown>)?.['email'] !== 'string',
  });
}

/** Batas per sumber. Sengaja longgar, hanya untuk menahan banjir permintaan. */
export function sourceLimiter({ handler }: AuthLimiterOptions): RequestHandler {
  return rateLimit({ ...shared, limit: 60, handler });
}
