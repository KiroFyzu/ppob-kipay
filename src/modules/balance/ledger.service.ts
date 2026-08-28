import { Prisma, PrismaClient } from '@prisma/client';
import { LedgerType } from '../../domain/enums';
import { conflict, badRequest } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';

/** Client Prisma di dalam interactive transaction. */
type TxClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export interface PostMutationInput {
  db: TxClient;
  userId: string;
  type: LedgerType;
  /** Bertanda: positif menambah saldo, negatif mengurangi. */
  amount: number;
  description: string;
  /**
   * Kunci unik mutasi, contoh "PURCHASE:<txId>". Constraint unique pada kolom
   * ini yang menjamin satu peristiwa hanya memindahkan uang satu kali,
   * berapa kali pun kodenya dipanggil ulang.
   */
  postingKey: string;
  transactionId?: string;
  depositId?: string;
  bankTransferId?: string;
  /** Izinkan saldo menjadi negatif. Hanya untuk penyesuaian manual admin. */
  allowNegative?: boolean;
}

export interface PostMutationResult {
  balanceBefore: number;
  balanceAfter: number;
  /** true kalau mutasi ini sudah pernah dibukukan sebelumnya. */
  alreadyPosted: boolean;
}

/**
 * Membukukan satu mutasi saldo. WAJIB dipanggil di dalam interactive
 * transaction agar pembacaan saldo dan penulisan ledger tidak bisa disisipi
 * operasi lain.
 *
 * Dua pengaman yang bekerja bersama:
 *   1. postingKey unique -> peristiwa yang sama tidak bisa dibukukan dua kali
 *   2. saldo dibaca ulang di dalam transaksi -> tidak ada perhitungan yang
 *      memakai nilai basi
 *
 * Baris user dikunci dengan `SELECT ... FOR UPDATE` supaya dua mutasi
 * konkuren terhadap user yang sama tidak saling menimpa saldo (lost update).
 */
export async function postMutation(
  input: PostMutationInput,
): Promise<PostMutationResult> {
  const { db, userId, type, amount, description, postingKey } = input;

  if (!Number.isInteger(amount)) {
    throw badRequest('INVALID_AMOUNT', 'Nominal mutasi harus bilangan bulat rupiah');
  }
  if (amount === 0) {
    throw badRequest('INVALID_AMOUNT', 'Nominal mutasi tidak boleh nol');
  }

  const existing = await db.ledgerEntry.findUnique({ where: { postingKey } });
  if (existing) {
    logger.warn({ postingKey }, 'Mutasi saldo diabaikan, sudah pernah dibukukan');
    return {
      balanceBefore: existing.balanceBefore,
      balanceAfter: existing.balanceAfter,
      alreadyPosted: true,
    };
  }

  const rows = await db.$queryRaw<{ balance: number }[]>(
    Prisma.sql`SELECT balance FROM users WHERE id = ${userId} FOR UPDATE`,
  );
  const user = rows[0];
  if (!user) {
    throw badRequest('USER_NOT_FOUND', 'User tidak ditemukan');
  }

  const balanceBefore = user.balance;
  const balanceAfter = balanceBefore + amount;

  if (balanceAfter < 0 && !input.allowNegative) {
    throw conflict('INSUFFICIENT_BALANCE', 'Saldo tidak mencukupi', {
      balance: balanceBefore,
      required: Math.abs(amount),
      shortBy: Math.abs(balanceAfter),
    });
  }

  try {
    await db.ledgerEntry.create({
      data: {
        userId,
        type,
        amount,
        balanceBefore,
        balanceAfter,
        description,
        postingKey,
        transactionId: input.transactionId ?? null,
        depositId: input.depositId ?? null,
        bankTransferId: input.bankTransferId ?? null,
      },
    });
  } catch (err) {
    // Ada proses lain yang membukukan peristiwa yang sama lebih dulu.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      const posted = await db.ledgerEntry.findUnique({ where: { postingKey } });
      if (posted) {
        return {
          balanceBefore: posted.balanceBefore,
          balanceAfter: posted.balanceAfter,
          alreadyPosted: true,
        };
      }
    }
    throw err;
  }

  await db.user.update({
    where: { id: userId },
    data: { balance: balanceAfter },
  });

  logger.info(
    { userId, type, amount, balanceAfter, postingKey },
    'Mutasi saldo dibukukan',
  );

  return { balanceBefore, balanceAfter, alreadyPosted: false };
}

/**
 * Menghitung ulang saldo dari seluruh ledger dan membandingkannya dengan kolom
 * cache `users.balance`. Dipakai worker audit untuk mendeteksi ketidakcocokan
 * sedini mungkin.
 */
export async function auditBalance(userId: string): Promise<{
  cached: number;
  computed: number;
  drift: number;
}> {
  const [user, aggregate] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { balance: true },
    }),
    prisma.ledgerEntry.aggregate({
      where: { userId },
      _sum: { amount: true },
    }),
  ]);

  const computed = aggregate._sum.amount ?? 0;
  return {
    cached: user.balance,
    computed,
    drift: user.balance - computed,
  };
}

export async function getLedgerHistory(
  userId: string,
  options: { limit: number; cursor?: string },
) {
  const entries = await prisma.ledgerEntry.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: options.limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      type: true,
      amount: true,
      balanceBefore: true,
      balanceAfter: true,
      description: true,
      createdAt: true,
      transactionId: true,
      depositId: true,
    },
  });

  const hasMore = entries.length > options.limit;
  return {
    entries: hasMore ? entries.slice(0, options.limit) : entries,
    nextCursor: hasMore ? entries[options.limit - 1]?.id ?? null : null,
  };
}
