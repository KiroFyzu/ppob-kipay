import { env } from './config/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { createApp } from './http/app';
import { startWorkers, stopWorkers } from './workers';

const app = createApp();

const server = app.listen(env.PORT, env.HOST, () => {
  logger.info(
    { port: env.PORT, mode: env.NODE_ENV, supplier: env.TOKOVOUCHER_MODE },
    `API berjalan di http://${env.HOST}:${env.PORT}`,
  );
});

// Worker dijalankan di proses yang sama supaya deployment tetap sederhana.
// Kalau nanti API di-scale ke banyak instance, jalankan worker sebagai proses
// terpisah (npm run worker) dan matikan baris ini -- kalau tidak, setiap
// instance akan memeriksa transaksi yang sama secara bersamaan.
startWorkers();

/**
 * Graceful shutdown. Penting untuk layanan yang memegang uang: proses yang
 * dibunuh di tengah transaksi bisa meninggalkan transaksi tanpa kepastian.
 */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Mematikan server...');

  stopWorkers();

  server.close(async () => {
    await prisma.$disconnect();
    logger.info('Server berhenti dengan bersih');
    process.exit(0);
  });

  // Jaring pengaman kalau ada koneksi yang tidak kunjung tertutup.
  setTimeout(() => {
    logger.error('Shutdown melewati batas waktu, keluar paksa');
    process.exit(1);
  }, 15_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception, proses dihentikan');
  process.exit(1);
});
