import { Prisma } from '@prisma/client';
import { env } from '../../config/env';
import { BANK_LABEL, LedgerType, TxStatus, isTerminal } from '../../domain/enums';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import {
  SupplierOrderResult,
  SupplierUnavailableError,
  supplier,
} from '../../providers/tokovoucher';
import { calculateSellPrice } from '../../utils/money';
import { generateRefId } from '../../utils/refid';
import { postMutation } from '../balance/ledger.service';
import { assertBankTransferAllowed } from '../transactions/fraud.service';

/** Sama seperti jadwal recheck topup e-wallet, lihat transaction.service.ts. */
const RECHECK_BACKOFF_SECONDS = [5, 10, 20, 40, 80, 160, 300, 600, 900];

function nextCheckDelay(attemptCount: number): number {
  const index = Math.min(attemptCount, RECHECK_BACKOFF_SECONDS.length - 1);
  return RECHECK_BACKOFF_SECONDS[index] ?? 1800;
}

/** Nomor rekening bank Indonesia: digit saja, panjang wajar. */
function normalizeAccountNumber(raw: string): string {
  const digits = raw.replace(/[\s\-]/g, '');
  if (!/^\d{6,20}$/.test(digits)) {
    throw badRequest(
      'INVALID_TARGET_NUMBER',
      'Nomor rekening tidak valid. Gunakan angka saja, 6-20 digit.',
    );
  }
  return digits;
}

function normalizeBankCode(raw: string): string {
  const code = raw.trim().toLowerCase();
  if (!code) {
    throw badRequest('INVALID_BANK_CODE', 'Kode bank wajib diisi');
  }
  return code;
}

export interface CreateBankTransferInput {
  userId: string;
  bankCode: string;
  targetNumber: string;
  nominal: number;
  idempotencyKey?: string;
}

export function toPublicBankTransfer(bt: {
  id: string;
  refId: string;
  bankCode: string;
  targetNumber: string;
  nominal: number;
  sellPrice: number;
  status: string;
  supplierMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}) {
  return {
    kind: 'BANK_TRANSFER' as const,
    id: bt.id,
    refId: bt.refId,
    bankCode: bt.bankCode,
    bankLabel: BANK_LABEL[bt.bankCode] ?? bt.bankCode.toUpperCase(),
    targetNumber: bt.targetNumber,
    nominal: bt.nominal,
    price: bt.sellPrice,
    status: bt.status,
    message: bt.supplierMessage,
    createdAt: bt.createdAt.toISOString(),
    completedAt: bt.completedAt?.toISOString() ?? null,
  };
}

/**
 * Membuat transfer bank. Alur dan alasannya sama persis dengan createTopup()
 * di transaction.service.ts: saldo didebit dan baris dicatat SEBELUM order
 * dikirim ke supplier, dalam satu database transaction, supaya tidak ada
 * jendela di mana uang keluar tanpa jejak.
 */
export async function createBankTransfer(input: CreateBankTransferInput) {
  const targetNumber = normalizeAccountNumber(input.targetNumber);
  const bankCode = normalizeBankCode(input.bankCode);

  if (!Number.isInteger(input.nominal) || input.nominal <= 0) {
    throw badRequest('INVALID_AMOUNT', 'Nominal harus bilangan bulat positif');
  }
  if (input.nominal < env.BANK_TRANSFER_MIN_AMOUNT) {
    throw badRequest(
      'AMOUNT_TOO_LOW',
      `Nominal minimum transfer bank adalah Rp${env.BANK_TRANSFER_MIN_AMOUNT}`,
    );
  }
  if (input.nominal > env.BANK_TRANSFER_MAX_AMOUNT) {
    throw badRequest(
      'AMOUNT_TOO_HIGH',
      `Nominal maksimum transfer bank adalah Rp${env.BANK_TRANSFER_MAX_AMOUNT}`,
    );
  }

  if (input.idempotencyKey) {
    const existing = await prisma.bankTransfer.findUnique({
      where: {
        userId_idempotencyKey: {
          userId: input.userId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (existing) {
      logger.info(
        { refId: existing.refId, idempotencyKey: input.idempotencyKey },
        'Idempotency hit, mengembalikan transfer bank yang sudah ada',
      );
      return { bankTransfer: existing, reused: true };
    }
  }

  await assertBankTransferAllowed({
    userId: input.userId,
    targetNumber,
    amount: input.nominal,
  });

  const basePrice = input.nominal;
  const sellPrice = calculateSellPrice(basePrice);
  const refId = generateRefId();

  let created;
  try {
    created = await prisma.$transaction(async (db) => {
      const bt = await db.bankTransfer.create({
        data: {
          refId,
          userId: input.userId,
          bankCode,
          targetNumber,
          nominal: input.nominal,
          basePrice,
          sellPrice,
          status: TxStatus.PENDING,
          idempotencyKey: input.idempotencyKey ?? null,
        },
      });

      await postMutation({
        db,
        userId: input.userId,
        type: LedgerType.PURCHASE,
        amount: -sellPrice,
        description: `Transfer bank ${BANK_LABEL[bankCode] ?? bankCode.toUpperCase()} ke ${targetNumber}`,
        postingKey: `PURCHASE:${bt.id}`,
        bankTransferId: bt.id,
      });

      return bt;
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002' &&
      input.idempotencyKey
    ) {
      const winner = await prisma.bankTransfer.findUnique({
        where: {
          userId_idempotencyKey: {
            userId: input.userId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (winner) return { bankTransfer: winner, reused: true };
    }
    throw err;
  }

  const dispatched = await dispatchToSupplier(created.id);
  return { bankTransfer: dispatched, reused: false };
}

/** Sama persis alasannya dengan dispatchToSupplier() milik topup e-wallet. */
export async function dispatchToSupplier(bankTransferId: string) {
  const bt = await prisma.bankTransfer.findUniqueOrThrow({
    where: { id: bankTransferId },
  });

  if (bt.status !== TxStatus.PENDING) {
    logger.warn(
      { refId: bt.refId, status: bt.status },
      'dispatchToSupplier (bank transfer) dilewati, sudah tidak PENDING',
    );
    return bt;
  }

  let result: SupplierOrderResult;
  try {
    result = await supplier.transferBank({
      refId: bt.refId,
      bankCode: bt.bankCode,
      accountNumber: bt.targetNumber,
      nominal: bt.nominal,
    });
  } catch (err) {
    if (err instanceof SupplierUnavailableError) {
      logger.error(
        { refId: bt.refId, err: err.message },
        'Supplier tidak bisa dihubungi, transfer bank ditahan sebagai PROCESSING',
      );
      return prisma.bankTransfer.update({
        where: { id: bt.id },
        data: {
          status: TxStatus.PROCESSING,
          supplierMessage: 'Menunggu konfirmasi supplier',
          attemptCount: { increment: 1 },
          lastCheckedAt: new Date(),
          nextCheckAt: new Date(Date.now() + nextCheckDelay(0) * 1000),
        },
      });
    }
    throw err;
  }

  return applySupplierResult(bt.id, result, 'order');
}

/** Sama persis alasannya dengan applySupplierResult() milik topup e-wallet. */
export async function applySupplierResult(
  bankTransferId: string,
  result: SupplierOrderResult,
  source: 'order' | 'reconcile' | 'callback',
) {
  return prisma.$transaction(async (db) => {
    const bt = await db.bankTransfer.findUniqueOrThrow({
      where: { id: bankTransferId },
    });

    if (isTerminal(bt.status)) {
      logger.info(
        { refId: bt.refId, status: bt.status, source },
        'Hasil supplier diabaikan, transfer bank sudah final',
      );
      return bt;
    }

    const now = new Date();
    const common = {
      supplierTrxId: result.trxId ?? bt.supplierTrxId,
      supplierStatus: result.status,
      supplierMessage: result.message,
      lastCheckedAt: now,
      attemptCount: bt.attemptCount + 1,
    };

    if (result.status === 'success') {
      logger.info({ refId: bt.refId, source }, 'Transfer bank sukses');
      return db.bankTransfer.update({
        where: { id: bt.id },
        data: {
          ...common,
          status: TxStatus.SUCCESS,
          completedAt: now,
          nextCheckAt: null,
        },
      });
    }

    if (result.status === 'failed') {
      await postMutation({
        db,
        userId: bt.userId,
        type: LedgerType.REFUND,
        amount: bt.sellPrice,
        description: `Refund transfer bank gagal ${bt.refId}`,
        postingKey: `REFUND:${bt.id}`,
        bankTransferId: bt.id,
      });

      logger.warn(
        { refId: bt.refId, source, message: result.message },
        'Transfer bank gagal, saldo dikembalikan',
      );

      return db.bankTransfer.update({
        where: { id: bt.id },
        data: {
          ...common,
          status: TxStatus.REFUNDED,
          completedAt: now,
          nextCheckAt: null,
        },
      });
    }

    return db.bankTransfer.update({
      where: { id: bt.id },
      data: {
        ...common,
        status: TxStatus.PROCESSING,
        nextCheckAt: new Date(Date.now() + nextCheckDelay(bt.attemptCount) * 1000),
      },
    });
  });
}

/** Sama persis alasannya dengan refundStuckTransaction() milik topup e-wallet. */
export async function refundStuckBankTransfer(bankTransferId: string, adminId: string) {
  return prisma.$transaction(async (db) => {
    const bt = await db.bankTransfer.findUniqueOrThrow({
      where: { id: bankTransferId },
    });

    if (bt.status !== TxStatus.PROCESSING) {
      throw badRequest(
        'NOT_PROCESSING',
        'Hanya transfer bank berstatus "Diproses" yang bisa di-refund manual',
      );
    }

    await postMutation({
      db,
      userId: bt.userId,
      type: LedgerType.REFUND,
      amount: bt.sellPrice,
      description: `Refund manual oleh admin ${adminId}: ${bt.refId}`,
      postingKey: `REFUND:${bt.id}`,
      bankTransferId: bt.id,
    });

    logger.warn(
      { refId: bt.refId, adminId },
      'Transfer bank PROCESSING di-refund manual oleh admin',
    );

    return db.bankTransfer.update({
      where: { id: bt.id },
      data: {
        status: TxStatus.REFUNDED,
        supplierMessage: `Refund manual oleh admin (${adminId})`,
        completedAt: new Date(),
        nextCheckAt: null,
      },
    });
  });
}

/** Sama persis alasannya dengan retryTransaction() milik topup e-wallet. */
const RETRY_COOLDOWN_MS = 15_000;

export async function retryBankTransfer(userId: string, refIdOrId: string) {
  const existing = await getBankTransfer(userId, refIdOrId);

  if (existing.status !== TxStatus.PROCESSING) {
    throw badRequest(
      'NOT_PROCESSING',
      'Hanya transfer bank berstatus "Diproses" yang bisa dicoba lagi',
    );
  }

  const sinceLastCheck = existing.lastCheckedAt
    ? Date.now() - existing.lastCheckedAt.getTime()
    : RETRY_COOLDOWN_MS;
  if (sinceLastCheck < RETRY_COOLDOWN_MS) {
    throw conflict(
      'RETRY_TOO_SOON',
      `Tunggu ${Math.ceil((RETRY_COOLDOWN_MS - sinceLastCheck) / 1000)} detik lagi sebelum mencoba lagi`,
    );
  }

  try {
    const status = await supplier.checkStatus(existing.refId);
    return await applySupplierResult(existing.id, status, 'order');
  } catch (err) {
    if (!(err instanceof SupplierUnavailableError)) throw err;
    logger.warn(
      { refId: existing.refId, reason: err.message },
      'Cek status gagal saat retry manual pengguna, mencoba kirim ulang transfer bank',
    );
  }

  try {
    const result = await supplier.transferBank({
      refId: existing.refId,
      bankCode: existing.bankCode,
      accountNumber: existing.targetNumber,
      nominal: existing.nominal,
    });
    return await applySupplierResult(existing.id, result, 'order');
  } catch (err) {
    if (err instanceof SupplierUnavailableError) {
      await prisma.bankTransfer.update({
        where: { id: existing.id },
        data: { lastCheckedAt: new Date() },
      });
      throw badRequest(
        'SUPPLIER_UNAVAILABLE',
        'Supplier masih belum bisa dihubungi, coba lagi beberapa saat lagi',
      );
    }
    throw err;
  }
}

export async function getBankTransfer(userId: string, refIdOrId: string) {
  const bt = await prisma.bankTransfer.findFirst({
    where: {
      userId,
      OR: [{ id: refIdOrId }, { refId: refIdOrId }],
    },
  });
  if (!bt) throw notFound('Transfer bank tidak ditemukan');
  return bt;
}

export async function listBankTransfers(
  userId: string,
  options: { limit: number; cursor?: string; status?: string },
) {
  const rows = await prisma.bankTransfer.findMany({
    where: {
      userId,
      ...(options.status ? { status: options.status } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: options.limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;

  return {
    bankTransfers: page.map(toPublicBankTransfer),
    nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
  };
}
