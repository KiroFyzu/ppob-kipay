import { Prisma } from '@prisma/client';
import { Brand, BRAND_LABEL, LedgerType, TxStatus, isTerminal } from '../../domain/enums';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import {
  SupplierOrderResult,
  SupplierUnavailableError,
  supplier,
} from '../../providers/tokovoucher';
import { generateRefId } from '../../utils/refid';
import { assertValidTarget, maskPhone, normalizePhone } from '../../utils/phone';
import { postMutation } from '../balance/ledger.service';
import { assertTransactionAllowed } from './fraud.service';

/**
 * Jadwal pemeriksaan ulang untuk transaksi yang masih menggantung, dalam detik
 * sejak transaksi dibuat. Rapat di awal karena mayoritas transaksi selesai
 * dalam hitungan detik, lalu melebar supaya tidak membanjiri supplier.
 */
const RECHECK_BACKOFF_SECONDS = [5, 10, 20, 40, 80, 160, 300, 600, 900];

function nextCheckDelay(attemptCount: number): number {
  const index = Math.min(attemptCount, RECHECK_BACKOFF_SECONDS.length - 1);
  return RECHECK_BACKOFF_SECONDS[index] ?? 1800;
}

export interface CreateTopupInput {
  userId: string;
  targetNumber: string;
  /** Pilih produk lewat brand + nominal, atau langsung lewat kodeProduk. */
  brand?: Brand;
  nominal?: number;
  kodeProduk?: string;
  idempotencyKey?: string;
}

/** Bentuk transaksi yang aman dikirim ke client. */
export function toPublicTransaction(tx: {
  id: string;
  refId: string;
  brand: string;
  kodeProduk: string;
  nominal: number;
  targetNumber: string;
  sellPrice: number;
  status: string;
  serialNumber: string | null;
  supplierMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}) {
  return {
    kind: 'EWALLET' as const,
    id: tx.id,
    refId: tx.refId,
    brand: tx.brand,
    brandLabel: BRAND_LABEL[tx.brand as Brand] ?? tx.brand,
    kodeProduk: tx.kodeProduk,
    nominal: tx.nominal,
    targetNumber: maskPhone(tx.targetNumber),
    price: tx.sellPrice,
    status: tx.status,
    serialNumber: tx.serialNumber,
    message: tx.supplierMessage,
    createdAt: tx.createdAt.toISOString(),
    completedAt: tx.completedAt?.toISOString() ?? null,
  };
}

async function resolveProduct(input: CreateTopupInput) {
  if (input.kodeProduk) {
    const product = await prisma.product.findUnique({
      where: { kodeProduk: input.kodeProduk },
    });
    if (!product) throw notFound(`Produk ${input.kodeProduk} tidak ditemukan`);
    return product;
  }

  if (!input.brand || input.nominal === undefined) {
    throw badRequest(
      'PRODUCT_NOT_SPECIFIED',
      'Sertakan kodeProduk, atau kombinasi brand dan nominal',
    );
  }

  const product = await prisma.product.findUnique({
    where: { brand_nominal: { brand: input.brand, nominal: input.nominal } },
  });

  if (!product) {
    throw notFound(
      `Nominal ${input.nominal} tidak tersedia untuk ${BRAND_LABEL[input.brand]}`,
    );
  }
  return product;
}

/**
 * Membuat transaksi topup.
 *
 * Urutannya disengaja: saldo didebit dan transaksi dicatat SEBELUM order
 * dikirim ke supplier, dalam satu database transaction. Kalau urutannya
 * dibalik, ada jendela waktu di mana order sudah terkirim tapi belum tercatat
 * -- dan kalau proses mati di jendela itu, uang keluar tanpa jejak.
 *
 * Panggilan HTTP ke supplier sengaja dilakukan DI LUAR database transaction.
 * Menahan transaksi database selama menunggu jaringan akan menahan row lock
 * (lihat SELECT ... FOR UPDATE di ledger.service.ts) selama beberapa detik
 * dan memblokir transaksi lain terhadap user yang sama.
 */
export async function createTopup(input: CreateTopupInput) {
  const targetNumber = normalizePhone(input.targetNumber);

  const product = await resolveProduct(input);
  const brand = product.brand as Brand;
  assertValidTarget(brand, targetNumber);

  if (!product.isActive) {
    throw conflict('PRODUCT_INACTIVE', 'Produk sedang tidak tersedia');
  }

  // Idempotency: kalau key yang sama pernah dipakai user ini, kembalikan
  // transaksi lama alih-alih membuat yang baru. Melindungi dari retry client,
  // koneksi putus, dan double-tap.
  if (input.idempotencyKey) {
    const existing = await prisma.transaction.findUnique({
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
        'Idempotency hit, mengembalikan transaksi yang sudah ada',
      );
      return { transaction: existing, reused: true };
    }
  }

  await assertTransactionAllowed({
    userId: input.userId,
    targetNumber,
    amount: product.nominal,
  });

  const refId = generateRefId();

  let created;
  try {
    created = await prisma.$transaction(async (db) => {
      const tx = await db.transaction.create({
        data: {
          refId,
          userId: input.userId,
          productId: product.id,
          kodeProduk: product.kodeProduk,
          brand: product.brand,
          nominal: product.nominal,
          targetNumber,
          basePrice: product.basePrice,
          sellPrice: product.sellPrice,
          status: TxStatus.PENDING,
          idempotencyKey: input.idempotencyKey ?? null,
        },
      });

      await postMutation({
        db,
        userId: input.userId,
        type: LedgerType.PURCHASE,
        amount: -product.sellPrice,
        description: `Topup ${BRAND_LABEL[brand]} ${product.nominal} ke ${maskPhone(targetNumber)}`,
        postingKey: `PURCHASE:${tx.id}`,
        transactionId: tx.id,
      });

      return tx;
    });
  } catch (err) {
    // Dua request dengan idempotency key sama tiba bersamaan; yang kalah
    // membaca hasil pemenang.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002' &&
      input.idempotencyKey
    ) {
      const winner = await prisma.transaction.findUnique({
        where: {
          userId_idempotencyKey: {
            userId: input.userId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (winner) return { transaction: winner, reused: true };
    }
    throw err;
  }

  const dispatched = await dispatchToSupplier(created.id);
  return { transaction: dispatched, reused: false };
}

/**
 * Mengirim transaksi ke supplier dan mencatat hasilnya.
 *
 * Aturan yang tidak boleh dilanggar: kalau supplier tidak bisa dihubungi, atau
 * membalas dengan sesuatu yang tidak dipahami, transaksi TIDAK di-refund.
 * Kegagalan jaringan berarti kita tidak tahu apakah order sudah masuk atau
 * belum. Me-refund saat itu berarti user bisa mendapat saldo e-wallet DAN
 * uangnya kembali. Transaksi dibiarkan PROCESSING agar worker memastikannya.
 */
export async function dispatchToSupplier(transactionId: string) {
  const tx = await prisma.transaction.findUniqueOrThrow({
    where: { id: transactionId },
  });

  if (tx.status !== TxStatus.PENDING) {
    logger.warn(
      { refId: tx.refId, status: tx.status },
      'dispatchToSupplier dilewati, transaksi tidak lagi PENDING',
    );
    return tx;
  }

  let result: SupplierOrderResult;
  try {
    result = await supplier.order({
      refId: tx.refId,
      kodeProduk: tx.kodeProduk,
      targetNumber: tx.targetNumber,
    });
  } catch (err) {
    if (err instanceof SupplierUnavailableError) {
      logger.error(
        { refId: tx.refId, err: err.message },
        'Supplier tidak bisa dihubungi, transaksi ditahan sebagai PROCESSING',
      );
      return prisma.transaction.update({
        where: { id: tx.id },
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

  return applySupplierResult(tx.id, result, 'order');
}

/**
 * Menerapkan hasil dari supplier ke satu transaksi. Ini satu-satunya tempat
 * status transaksi berpindah, dipakai bersama oleh jalur order, worker
 * rekonsiliasi, dan callback webhook -- supaya tidak ada tiga versi aturan
 * yang berbeda.
 */
export async function applySupplierResult(
  transactionId: string,
  result: SupplierOrderResult,
  source: 'order' | 'reconcile' | 'callback',
) {
  return prisma.$transaction(async (db) => {
    const tx = await db.transaction.findUniqueOrThrow({
      where: { id: transactionId },
    });

    // Status akhir tidak pernah dibuka lagi. Callback yang datang terlambat
    // atau terkirim ganda tidak boleh mengubah transaksi yang sudah selesai.
    if (isTerminal(tx.status)) {
      logger.info(
        { refId: tx.refId, status: tx.status, source },
        'Hasil supplier diabaikan, transaksi sudah final',
      );
      return tx;
    }

    const now = new Date();
    const common = {
      supplierTrxId: result.trxId ?? tx.supplierTrxId,
      supplierStatus: result.status,
      supplierMessage: result.message,
      lastCheckedAt: now,
      attemptCount: tx.attemptCount + 1,
    };

    if (result.status === 'success') {
      logger.info({ refId: tx.refId, source }, 'Transaksi sukses');
      return db.transaction.update({
        where: { id: tx.id },
        data: {
          ...common,
          status: TxStatus.SUCCESS,
          serialNumber: result.serialNumber ?? tx.serialNumber,
          completedAt: now,
          nextCheckAt: null,
        },
      });
    }

    if (result.status === 'failed') {
      // Kembalikan saldo. postingKey memastikan refund hanya sekali, bahkan
      // kalau callback gagal dikirim berkali-kali.
      await postMutation({
        db,
        userId: tx.userId,
        type: LedgerType.REFUND,
        amount: tx.sellPrice,
        description: `Refund transaksi gagal ${tx.refId}`,
        postingKey: `REFUND:${tx.id}`,
        transactionId: tx.id,
      });

      logger.warn(
        { refId: tx.refId, source, message: result.message },
        'Transaksi gagal, saldo dikembalikan',
      );

      return db.transaction.update({
        where: { id: tx.id },
        data: {
          ...common,
          status: TxStatus.REFUNDED,
          completedAt: now,
          nextCheckAt: null,
        },
      });
    }

    // Masih menggantung: jadwalkan pemeriksaan berikutnya.
    return db.transaction.update({
      where: { id: tx.id },
      data: {
        ...common,
        status: TxStatus.PROCESSING,
        nextCheckAt: new Date(Date.now() + nextCheckDelay(tx.attemptCount) * 1000),
      },
    });
  });
}

/**
 * Refund manual oleh admin untuk transaksi yang masih PROCESSING -- dipakai
 * saat transaksi macet lama tanpa kepastian dari supplier (mis. order awal
 * tidak pernah benar-benar sampai ke supplier, jadi checkStatus tidak akan
 * pernah menemukan hasilnya). Sengaja hanya boleh untuk PROCESSING, bukan
 * status apa pun: admin wajib sudah memastikan sendiri saldonya belum
 * benar-benar terkirim, karena begitu di-refund, hasil supplier yang datang
 * belakangan (sukses) akan diabaikan oleh applySupplierResult() -- lihat
 * pengecekan isTerminal() di sana.
 */
export async function refundStuckTransaction(transactionId: string, adminId: string) {
  return prisma.$transaction(async (db) => {
    const tx = await db.transaction.findUniqueOrThrow({
      where: { id: transactionId },
    });

    if (tx.status !== TxStatus.PROCESSING) {
      throw badRequest(
        'NOT_PROCESSING',
        'Hanya transaksi berstatus "Diproses" yang bisa di-refund manual',
      );
    }

    await postMutation({
      db,
      userId: tx.userId,
      type: LedgerType.REFUND,
      amount: tx.sellPrice,
      description: `Refund manual oleh admin ${adminId}: ${tx.refId}`,
      postingKey: `REFUND:${tx.id}`,
      transactionId: tx.id,
    });

    logger.warn(
      { refId: tx.refId, adminId },
      'Transaksi PROCESSING di-refund manual oleh admin',
    );

    return db.transaction.update({
      where: { id: tx.id },
      data: {
        status: TxStatus.REFUNDED,
        supplierMessage: `Refund manual oleh admin (${adminId})`,
        completedAt: new Date(),
        nextCheckAt: null,
      },
    });
  });
}

/** Jeda minimum antar klik "Coba Lagi" pengguna, supaya tidak membanjiri supplier. */
const RETRY_COOLDOWN_MS = 15_000;

/**
 * Dipanggil pengguna sendiri lewat tombol "Coba lagi" saat transaksinya
 * nyangkut di PROCESSING. Coba cek status dulu (siapa tahu ternyata sudah
 * final tapi belum sempat dibaca worker) -- kalau supplier balas "tidak
 * ditemukan" atau memang tidak bisa dihubungi, kirim ulang order dengan refId
 * yang sama. Aman diulang karena refId dipakai supplier sebagai kunci
 * idempotensi, jadi tidak akan tercatat dua kali di sisi mereka.
 */
export async function retryTransaction(userId: string, refIdOrId: string) {
  const existing = await getTransaction(userId, refIdOrId);

  if (existing.status !== TxStatus.PROCESSING) {
    throw badRequest(
      'NOT_PROCESSING',
      'Hanya transaksi berstatus "Diproses" yang bisa dicoba lagi',
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
      'Cek status gagal saat retry manual pengguna, mencoba kirim ulang order',
    );
  }

  try {
    const result = await supplier.order({
      refId: existing.refId,
      kodeProduk: existing.kodeProduk,
      targetNumber: existing.targetNumber,
    });
    return await applySupplierResult(existing.id, result, 'order');
  } catch (err) {
    if (err instanceof SupplierUnavailableError) {
      await prisma.transaction.update({
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

export async function getTransaction(userId: string, refIdOrId: string) {
  const tx = await prisma.transaction.findFirst({
    where: {
      userId,
      OR: [{ id: refIdOrId }, { refId: refIdOrId }],
    },
  });
  if (!tx) throw notFound('Transaksi tidak ditemukan');
  return tx;
}

export async function listTransactions(
  userId: string,
  options: { limit: number; cursor?: string; status?: string },
) {
  const rows = await prisma.transaction.findMany({
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
    transactions: page.map(toPublicTransaction),
    nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
  };
}
