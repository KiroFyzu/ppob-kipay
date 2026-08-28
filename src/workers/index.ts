import { env } from '../config/env';
import { logger } from '../lib/logger';
import { expireStaleDeposits, pollPendingKipayDeposits } from '../modules/balance/deposit.service';
import { runReconcileCycle } from './reconcile.worker';

/**
 * Penjadwal sederhana berbasis interval.
 *
 * Sengaja tidak memakai Redis atau antrian eksternal: pekerjaannya hanya
 * "cari baris yang jatuh tempo, proses, ulangi", dan itu sudah dilayani baik
 * oleh query berindeks. Satu dependensi infrastruktur lebih sedikit berarti
 * satu hal lebih sedikit yang bisa mati saat produksi.
 *
 * Batasnya jelas: ini mengasumsikan HANYA SATU proses worker yang berjalan.
 * Saat API di-scale ke banyak instance, jalankan worker sebagai satu proses
 * tersendiri (npm run worker), bukan ikut di tiap instance API.
 */

let running = false;
const timers: NodeJS.Timeout[] = [];

/**
 * Menjalankan tugas berulang tanpa saling menumpuk. Interval dihitung setelah
 * tugas selesai, bukan dari waktu mulai -- jadi siklus yang lambat tidak
 * memicu siklus berikutnya sebelum yang sekarang beres.
 */
function schedule(name: string, intervalMs: number, task: () => Promise<unknown>): void {
  const tick = async (): Promise<void> => {
    if (!running) return;
    try {
      await task();
    } catch (err) {
      logger.error({ err, worker: name }, 'Worker gagal pada satu siklus');
    } finally {
      if (running) {
        const timer = setTimeout(() => void tick(), intervalMs);
        timer.unref();
        timers.push(timer);
      }
    }
  };

  void tick();
}

export function startWorkers(): void {
  if (running) return;
  running = true;

  schedule('reconcile', env.RECONCILE_INTERVAL_MS, runReconcileCycle);
  schedule('expire-deposits', 60_000, expireStaleDeposits);
  // Fallback kalau webhook KiPay tidak pernah sampai -- lihat komentar di
  // pollPendingKipayDeposits().
  schedule('poll-kipay-deposits', env.RECONCILE_INTERVAL_MS, pollPendingKipayDeposits);

  logger.info(
    { reconcileIntervalMs: env.RECONCILE_INTERVAL_MS },
    'Worker dijalankan',
  );
}

export function stopWorkers(): void {
  running = false;
  for (const timer of timers) clearTimeout(timer);
  timers.length = 0;
  logger.info('Worker dihentikan');
}

// Mendukung dijalankan sebagai proses mandiri: npm run worker
if (require.main === module) {
  startWorkers();
  process.on('SIGTERM', () => {
    stopWorkers();
    process.exit(0);
  });
  process.on('SIGINT', () => {
    stopWorkers();
    process.exit(0);
  });
}
