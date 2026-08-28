import { env } from '../../config/env';
import { TxStatus } from '../../domain/enums';
import { forbidden, tooManyRequests } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { maskPhone } from '../../utils/phone';

/**
 * Pemeriksaan sebelum uang bergerak.
 *
 * Alasan lapisan ini ada: saldo e-wallet bersifat likuid -- begitu terkirim,
 * penerima bisa langsung memindahkan atau mencairkannya, dan transaksinya
 * tidak bisa ditarik kembali. Jadi satu-satunya titik kendali yang efektif
 * adalah SEBELUM order dikirim ke supplier.
 *
 * Semua batas dikonfigurasi lewat environment supaya bisa disesuaikan tanpa
 * mengubah kode.
 */

/** Status yang dianggap "uang sudah atau sedang bergerak". */
const COUNTED_STATUSES = [
  TxStatus.PENDING,
  TxStatus.PROCESSING,
  TxStatus.SUCCESS,
];

export interface FraudCheckInput {
  userId: string;
  targetNumber: string;
  amount: number;
}

export async function assertTransactionAllowed({
  userId,
  targetNumber,
  amount,
}: FraudCheckInput): Promise<void> {
  const now = Date.now();
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
  const hourAgo = new Date(now - 60 * 60 * 1000);

  // 1. Nomor yang sudah masuk daftar blokir.
  const blocked = await prisma.blockedTarget.findUnique({
    where: { number: targetNumber },
  });
  if (blocked) {
    logger.warn(
      { userId, target: maskPhone(targetNumber), reason: blocked.reason },
      'Transaksi ditolak: nomor tujuan diblokir',
    );
    throw forbidden('Nomor tujuan tidak dapat digunakan.');
  }

  // 2. Jeda minimum ke nomor tujuan yang sama. Menahan skrip yang menembak
  //    berulang kali, dan menahan user yang tidak sengaja klik dua kali.
  const lastToTarget = await prisma.transaction.findFirst({
    where: { targetNumber, status: { in: COUNTED_STATUSES } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });

  if (lastToTarget) {
    const elapsedSeconds = (now - lastToTarget.createdAt.getTime()) / 1000;
    if (elapsedSeconds < env.FRAUD_MIN_INTERVAL_SECONDS) {
      const waitFor = Math.ceil(env.FRAUD_MIN_INTERVAL_SECONDS - elapsedSeconds);
      throw tooManyRequests(
        'TARGET_COOLDOWN',
        `Tunggu ${waitFor} detik lagi sebelum mengirim ke nomor yang sama.`,
        { retryAfterSeconds: waitFor },
      );
    }
  }

  // 3. Jumlah dan total nilai transaksi ke satu nomor tujuan dalam 24 jam.
  //    Batas ini berlaku lintas user -- kalau tidak, pelaku tinggal membuat
  //    banyak akun untuk menembak nomor yang sama.
  const targetDaily = await prisma.transaction.aggregate({
    where: {
      targetNumber,
      status: { in: COUNTED_STATUSES },
      createdAt: { gte: dayAgo },
    },
    _count: { _all: true },
    _sum: { nominal: true },
  });

  const targetCount = targetDaily._count._all;
  const targetAmount = targetDaily._sum.nominal ?? 0;

  if (targetCount >= env.FRAUD_MAX_TX_PER_TARGET_DAY) {
    logger.warn(
      { userId, target: maskPhone(targetNumber), targetCount },
      'Transaksi ditolak: batas harian per nomor tujuan tercapai',
    );
    throw tooManyRequests(
      'TARGET_DAILY_LIMIT',
      'Nomor tujuan ini sudah mencapai batas transaksi harian.',
    );
  }

  if (targetAmount + amount > env.FRAUD_MAX_AMOUNT_PER_TARGET_DAY) {
    logger.warn(
      { userId, target: maskPhone(targetNumber), targetAmount, amount },
      'Transaksi ditolak: batas nominal harian per nomor tujuan terlampaui',
    );
    throw tooManyRequests(
      'TARGET_AMOUNT_LIMIT',
      'Nomor tujuan ini sudah mencapai batas nominal harian.',
    );
  }

  // 4. Kecepatan transaksi per user.
  const userHourly = await prisma.transaction.count({
    where: {
      userId,
      status: { in: COUNTED_STATUSES },
      createdAt: { gte: hourAgo },
    },
  });

  if (userHourly >= env.FRAUD_MAX_TX_PER_USER_HOUR) {
    logger.warn({ userId, userHourly }, 'Transaksi ditolak: batas per jam user tercapai');
    throw tooManyRequests(
      'USER_HOURLY_LIMIT',
      'Kamu sudah mencapai batas transaksi per jam. Coba lagi nanti.',
    );
  }
}

/**
 * Sama seperti assertTransactionAllowed(), tapi terhadap tabel BankTransfer.
 * Model terpisah karena transfer bank bukan bagian dari katalog Product, tapi
 * daftar blokir (BlockedTarget) tetap dipakai bersama -- nomor rekening yang
 * diblokir ya diblokir, tidak peduli lewat kanal mana.
 */
export async function assertBankTransferAllowed({
  userId,
  targetNumber,
  amount,
}: FraudCheckInput): Promise<void> {
  const now = Date.now();
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
  const hourAgo = new Date(now - 60 * 60 * 1000);

  const blocked = await prisma.blockedTarget.findUnique({
    where: { number: targetNumber },
  });
  if (blocked) {
    logger.warn(
      { userId, target: targetNumber, reason: blocked.reason },
      'Transfer bank ditolak: rekening tujuan diblokir',
    );
    throw forbidden('Rekening tujuan tidak dapat digunakan.');
  }

  const lastToTarget = await prisma.bankTransfer.findFirst({
    where: { targetNumber, status: { in: COUNTED_STATUSES } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });

  if (lastToTarget) {
    const elapsedSeconds = (now - lastToTarget.createdAt.getTime()) / 1000;
    if (elapsedSeconds < env.FRAUD_MIN_INTERVAL_SECONDS) {
      const waitFor = Math.ceil(env.FRAUD_MIN_INTERVAL_SECONDS - elapsedSeconds);
      throw tooManyRequests(
        'TARGET_COOLDOWN',
        `Tunggu ${waitFor} detik lagi sebelum mengirim ke rekening yang sama.`,
        { retryAfterSeconds: waitFor },
      );
    }
  }

  const targetDaily = await prisma.bankTransfer.aggregate({
    where: {
      targetNumber,
      status: { in: COUNTED_STATUSES },
      createdAt: { gte: dayAgo },
    },
    _count: { _all: true },
    _sum: { nominal: true },
  });

  const targetCount = targetDaily._count._all;
  const targetAmount = targetDaily._sum.nominal ?? 0;

  if (targetCount >= env.FRAUD_MAX_TX_PER_TARGET_DAY) {
    logger.warn(
      { userId, target: targetNumber, targetCount },
      'Transfer bank ditolak: batas harian per rekening tujuan tercapai',
    );
    throw tooManyRequests(
      'TARGET_DAILY_LIMIT',
      'Rekening tujuan ini sudah mencapai batas transaksi harian.',
    );
  }

  if (targetAmount + amount > env.FRAUD_MAX_AMOUNT_PER_TARGET_DAY) {
    logger.warn(
      { userId, target: targetNumber, targetAmount, amount },
      'Transfer bank ditolak: batas nominal harian per rekening tujuan terlampaui',
    );
    throw tooManyRequests(
      'TARGET_AMOUNT_LIMIT',
      'Rekening tujuan ini sudah mencapai batas nominal harian.',
    );
  }

  const userHourly = await prisma.bankTransfer.count({
    where: {
      userId,
      status: { in: COUNTED_STATUSES },
      createdAt: { gte: hourAgo },
    },
  });

  if (userHourly >= env.FRAUD_MAX_TX_PER_USER_HOUR) {
    logger.warn({ userId, userHourly }, 'Transfer bank ditolak: batas per jam user tercapai');
    throw tooManyRequests(
      'USER_HOURLY_LIMIT',
      'Kamu sudah mencapai batas transaksi per jam. Coba lagi nanti.',
    );
  }
}

export async function blockTarget(
  number: string,
  reason: string,
  createdBy?: string,
) {
  return prisma.blockedTarget.upsert({
    where: { number },
    create: { number, reason, createdBy: createdBy ?? null },
    update: { reason, createdBy: createdBy ?? null },
  });
}

export async function unblockTarget(number: string) {
  await prisma.blockedTarget.deleteMany({ where: { number } });
}
