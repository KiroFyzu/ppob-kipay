import path from 'node:path';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Express } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { issueCsrfToken } from '../web/csrf';
import { viewHelpers } from '../web/view-helpers';
import { loadWebUser } from '../web/web-auth.middleware';
import { webRouter } from '../web/web.routes';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import { adminRouter } from './routes/admin.routes';
import { authRouter } from './routes/auth.routes';
import { balanceRouter } from './routes/balance.routes';
import { bankTransferRouter } from './routes/bank-transfer.routes';
import { productRouter } from './routes/product.routes';
import { transactionRouter } from './routes/transaction.routes';
import { webhookRouter } from './routes/webhook.routes';

/** Akar proyek, dihitung dari lokasi file ini agar sama saat dev maupun build. */
const ROOT = path.resolve(__dirname, '..', '..');

export function createApp(): Express {
  const app = express();

  // Di belakang reverse proxy, tanpa ini req.ip berisi IP proxy sehingga
  // seluruh rate limit berbagi satu kunci yang sama.
  app.set('trust proxy', 1);

  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));

  // Fungsi format dipakai langsung dari template, jadi dipasang sebagai locals
  // global alih-alih diteruskan berulang kali oleh setiap handler.
  Object.assign(app.locals, viewHelpers, {
    supplierMode: env.TOKOVOUCHER_MODE,
    user: null,
    currentPath: '',
    csrfToken: '',
  });

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // Tidak ada 'unsafe-inline'. CSP yang mengizinkan inline script
          // kehilangan sebagian besar manfaatnya sebagai penahan XSS, jadi
          // seluruh CSS dan JS halaman berada di file terpisah.
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
        },
      },
    }),
  );

  app.use(
    cors({
      origin:
        env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',').map((s) => s.trim()),
      credentials: true,
    }),
  );

  // Aset statis dilayani sebelum rate limiter supaya CSS dan JS satu halaman
  // tidak ikut menghabiskan jatah permintaan pengguna.
  app.use(
    express.static(path.join(ROOT, 'public'), {
      maxAge: env.NODE_ENV === 'production' ? '7d' : 0,
    }),
  );

  // rawBody disimpan karena signature webhook dihitung dari byte asli;
  // JSON.stringify(req.body) bisa menghasilkan urutan atau spasi berbeda.
  app.use(
    express.json({
      limit: '256kb',
      verify: (req, _res, buf) => {
        (req as { rawBody?: string }).rawBody = buf.toString('utf8');
      },
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));
  app.use(cookieParser());

  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/health' },
      // Request yang sukses turun ke level 'debug': dengan LOG_LEVEL=info
      // (bawaan produksi) mereka tidak muncul sama sekali, jadi console tidak
      // dibanjiri satu baris per klik pengguna. Error tetap di level aslinya
      // (warn untuk 4xx, error untuk 5xx) supaya tidak pernah tersembunyi.
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'debug';
      },
      // Baris ringkas: cukup untuk tahu request apa yang lewat, tanpa dump
      // header dan objek req/res lengkap yang jarang benar-benar dibaca.
      customSuccessMessage: (req, res) => `${req.method} ${req.url} -> ${res.statusCode}`,
      customErrorMessage: (req, res, err) =>
        `${req.method} ${req.url} -> ${res.statusCode} (${err.message})`,
      serializers: { req: () => undefined, res: () => undefined },
    }),
  );

  // Pembatas kasar untuk seluruh permintaan dinamis. Batas yang lebih ketat
  // dipasang per-endpoint di router masing-masing.
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: 200,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  app.get('/health', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({
        status: 'ok',
        supplierMode: env.TOKOVOUCHER_MODE,
        uptime: Math.round(process.uptime()),
      });
    } catch {
      res.status(503).json({ status: 'degraded', database: 'unreachable' });
    }
  });

  // --- API ----------------------------------------------------------------
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/products', productRouter);
  app.use('/api/v1/transactions', transactionRouter);
  app.use('/api/v1/bank-transfers', bankTransferRouter);
  app.use('/api/v1/balance', balanceRouter);
  app.use('/api/v1/admin', adminRouter);
  app.use('/api/v1/webhooks', webhookRouter);

  // --- Halaman web --------------------------------------------------------
  // Sesi cookie dan token CSRF hanya berlaku di sini; API tetap memakai
  // header Authorization dan tidak menyentuh cookie sama sekali.
  app.use(issueCsrfToken, loadWebUser, webRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
