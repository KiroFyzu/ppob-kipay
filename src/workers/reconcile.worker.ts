import { env } from '../config/env';
import { TxStatus } from '../domain/enums';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { SupplierUnavailableError, supplier } from '../providers/tokovoucher';
import {
  applySupplierResult,
  dispatchToSupplier,
} from '../modules/transactions/transaction.service';
import {
  applySupplierResult as applyBankTransferResult,
  dispatchToSupplier as dispatchBankTransferToSupplier,
} from '../modules/bank-transfer/bank-transfer.service';

/**
 * Worker rekonsiliasi.
 *
 * Alasan worker ini wajib ada: callback supplier tidak bisa diandalkan. Ia
 * bisa gagal terkirim, datang terlambat, atau tidak pernah datang sama sekali.
 * Tanpa pemeriksaan aktif, transaksi akan menggantung selamanya -- saldo user
 * sudah terpotong tapi tidak ada kepastian, dan itu yang paling cepat
 * menghancurkan kepercayaan.
 *
 * Ada dua pekerjaan di sini:
 *   1. Menyelamatkan transaksi PENDING yang tidak pernah terkirim
 *   2. Memeriksa status transaksi PROCESSING sampai mendapat status akhir
 */

/**
 * Menangani transaksi yang saldonya sudah terpotong tapi belum pernah dikirim
 * ke supplier -- biasanya karena proses mati tepat di antara dua langkah itu.
 *
 * Aman dikirim ulang karena refId dipakai supplier sebagai kunci idempotensi:
 * refId yang sama tidak akan diproses dua kali di sisi mereka.
 */
async function rescueStrandedPending(): Promise<number> {
  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);

  const stranded = await prisma.transaction.findMany({
    where: { status: TxStatus.PENDING, createdAt: { lt: twoMinutesAgo } },
    take: env.RECONCILE_BATCH_SIZE,
    orderBy: { createdAt: 'asc' },
    select: { id: true, refId: true },
  });

  for (const tx of stranded) {
    logger.warn({ refId: tx.refId }, 'Transaksi PENDING terlantar, dikirim ulang');
    try {
      await dispatchToSupplier(tx.id);
    } catch (err) {
      logger.error({ err, refId: tx.refId }, 'Gagal mengirim ulang transaksi terlantar');
    }
  }

  return stranded.length;
}

/** Memeriksa status transaksi yang sudah jatuh tempo untuk dicek ulang. */
async function reconcileProcessing(): Promise<number> {
  const due = await prisma.transaction.findMany({
    where: {
      status: TxStatus.PROCESSING,
      nextCheckAt: { lte: new Date() },
    },
    take: env.RECONCILE_BATCH_SIZE,
    orderBy: { nextCheckAt: 'asc' },
    select: { id: true, refId: true, createdAt: true, attemptCount: true },
  });

  // Alasan penolakan biasanya sama untuk semua transaksi yang macet karena
  // supplier (mis. IP belum di-whitelist). Log satu baris per alasan unik di
  // akhir siklus, bukan satu warning per transaksi -- kalau tidak, delapan
  // transaksi macet berarti delapan baris identik setiap 15 detik selamanya.
  const unavailableReasons = new Map<string, number>();

  for (const tx of due) {
    const ageMinutes = (Date.now() - tx.createdAt.getTime()) / 60_000;

    // Terlalu lama tanpa kepastian. Sengaja TIDAK di-refund otomatis: kalau
    // saldonya ternyata sudah terkirim, refund berarti user mendapat dua-duanya.
    // Ditandai supaya admin memeriksanya lewat dashboard supplier.
    if (ageMinutes > env.RECONCILE_STUCK_AFTER_MINUTES) {
      await prisma.transaction.update({
        where: { id: tx.id },
        data: {
          flaggedReason: `Belum ada kepastian setelah ${Math.round(ageMinutes)} menit`,
          // Tetap diperiksa, tapi jauh lebih jarang.
          nextCheckAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      });
      logger.error(
        { refId: tx.refId, ageMinutes: Math.round(ageMinutes) },
        'Transaksi macet, ditandai untuk pemeriksaan manual',
      );
      continue;
    }

    try {
      const result = await supplier.checkStatus(tx.refId);
      await applySupplierResult(tx.id, result, 'reconcile');
    } catch (err) {
      if (err instanceof SupplierUnavailableError) {
        // Supplier sedang bermasalah. Mundur sebentar, jangan ubah status.
        await prisma.transaction.update({
          where: { id: tx.id },
          data: {
            lastCheckedAt: new Date(),
            nextCheckAt: new Date(Date.now() + 15_000),
          },
        });
        logger.debug(
          { refId: tx.refId, reason: err.message },
          'Supplier tidak bisa dihubungi saat rekonsiliasi',
        );
        unavailableReasons.set(err.message, (unavailableReasons.get(err.message) ?? 0) + 1);
        continue;
      }
      logger.error({ err, refId: tx.refId }, 'Gagal merekonsiliasi transaksi');
    }
  }

  for (const [reason, count] of unavailableReasons) {
    logger.warn({ count, reason }, 'Transaksi ditunda, supplier tidak bisa dihubungi');
  }

  return due.length;
}

/** Sama persis alasannya dengan rescueStrandedPending() milik topup e-wallet. */
async function rescueStrandedBankTransfers(): Promise<number> {
  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);

  const stranded = await prisma.bankTransfer.findMany({
    where: { status: TxStatus.PENDING, createdAt: { lt: twoMinutesAgo } },
    take: env.RECONCILE_BATCH_SIZE,
    orderBy: { createdAt: 'asc' },
    select: { id: true, refId: true },
  });

  for (const bt of stranded) {
    logger.warn({ refId: bt.refId }, 'Transfer bank PENDING terlantar, dikirim ulang');
    try {
      await dispatchBankTransferToSupplier(bt.id);
    } catch (err) {
      logger.error({ err, refId: bt.refId }, 'Gagal mengirim ulang transfer bank terlantar');
    }
  }

  return stranded.length;
}

/** Sama persis alasannya dengan reconcileProcessing() milik topup e-wallet. */
async function reconcileBankTransfersProcessing(): Promise<number> {
  const due = await prisma.bankTransfer.findMany({
    where: {
      status: TxStatus.PROCESSING,
      nextCheckAt: { lte: new Date() },
    },
    take: env.RECONCILE_BATCH_SIZE,
    orderBy: { nextCheckAt: 'asc' },
    select: { id: true, refId: true, createdAt: true, attemptCount: true },
  });

  const unavailableReasons = new Map<string, number>();

  for (const bt of due) {
    const ageMinutes = (Date.now() - bt.createdAt.getTime()) / 60_000;

    if (ageMinutes > env.RECONCILE_STUCK_AFTER_MINUTES) {
      await prisma.bankTransfer.update({
        where: { id: bt.id },
        data: {
          flaggedReason: `Belum ada kepastian setelah ${Math.round(ageMinutes)} menit`,
          nextCheckAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      });
      logger.error(
        { refId: bt.refId, ageMinutes: Math.round(ageMinutes) },
        'Transfer bank macet, ditandai untuk pemeriksaan manual',
      );
      continue;
    }

    try {
      const result = await supplier.checkStatus(bt.refId);
      await applyBankTransferResult(bt.id, result, 'reconcile');
    } catch (err) {
      if (err instanceof SupplierUnavailableError) {
        await prisma.bankTransfer.update({
          where: { id: bt.id },
          data: {
            lastCheckedAt: new Date(),
            nextCheckAt: new Date(Date.now() + 15_000),
          },
        });
        logger.debug(
          { refId: bt.refId, reason: err.message },
          'Supplier tidak bisa dihubungi saat rekonsiliasi transfer bank',
        );
        unavailableReasons.set(err.message, (unavailableReasons.get(err.message) ?? 0) + 1);
        continue;
      }
      logger.error({ err, refId: bt.refId }, 'Gagal merekonsiliasi transfer bank');
    }
  }

  for (const [reason, count] of unavailableReasons) {
    logger.warn({ count, reason }, 'Transfer bank ditunda, supplier tidak bisa dihubungi');
  }

  return due.length;
}

export async function runReconcileCycle(): Promise<void> {
  const [rescued, reconciled, rescuedBankTransfers, reconciledBankTransfers] = [
    await rescueStrandedPending(),
    await reconcileProcessing(),
    await rescueStrandedBankTransfers(),
    await reconcileBankTransfersProcessing(),
  ];

  if (rescued > 0 || reconciled > 0 || rescuedBankTransfers > 0 || reconciledBankTransfers > 0) {
    logger.debug(
      { rescued, reconciled, rescuedBankTransfers, reconciledBankTransfers },
      'Siklus rekonsiliasi selesai',
    );
  }
}
