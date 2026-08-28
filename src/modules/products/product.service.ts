import { Brand, BRAND_LABEL, JENIS_ID_TO_BRAND, KODE_PREFIX_TO_BRAND } from '../../domain/enums';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { supplier } from '../../providers/tokovoucher';
import { calculateSellPrice } from '../../utils/money';

/**
 * Menentukan brand dari satu baris katalog supplier.
 *
 * jenis_id dipakai lebih dulu karena itu yang paling stabil. Nama produk
 * sengaja TIDAK pernah dipakai: di katalog TokoVoucher, produk GoPay
 * (jenis_id 125) tercatat dengan nama "Customer 10.000", sehingga menebak
 * brand dari nama akan salah.
 */
export function detectBrand(jenisId: number, kodeProduk: string): Brand | null {
  const byJenis = JENIS_ID_TO_BRAND[jenisId];
  if (byJenis) return byJenis;

  const upper = kodeProduk.toUpperCase();
  for (const [prefix, brand] of KODE_PREFIX_TO_BRAND) {
    if (upper.startsWith(prefix)) return brand;
  }
  return null;
}

/**
 * Mengambil nominal dari nama produk, contoh "Dana 10.000" -> 10000.
 * Dipakai saat impor katalog, karena supplier tidak mengirim nominal sebagai
 * field tersendiri.
 */
export function parseNominal(namaProduk: string, kodeProduk: string): number | null {
  const fromName = namaProduk.match(/([\d][\d.,]*)/);
  if (fromName?.[1]) {
    const digits = fromName[1].replace(/[.,]/g, '');
    const value = Number(digits);
    if (Number.isFinite(value) && value >= 1000) return value;
  }

  // Fallback: angka di ujung kode produk adalah nominal dalam ribuan,
  // contoh DANA25 -> 25.000. Kode seperti DANA5000 sudah menyebut nominal
  // penuh, jadi angka >= 1000 dipakai apa adanya.
  const fromCode = kodeProduk.match(/(\d+)$/);
  if (fromCode?.[1]) {
    const value = Number(fromCode[1]);
    if (!Number.isFinite(value)) return null;
    return value >= 1000 ? value : value * 1000;
  }

  return null;
}

export interface CatalogRow {
  kodeProduk: string;
  jenisId: number;
  namaProduk: string;
  basePrice: number;
  isActive: boolean;
}

export interface SyncResult {
  created: number;
  updated: number;
  skipped: Array<{ kodeProduk: string; reason: string }>;
}

/**
 * Menyimpan katalog ke database dan menghitung ulang harga jual.
 *
 * Harga jual selalu diturunkan dari harga modal terbaru, jadi setiap kali
 * supplier menaikkan harga, margin tetap terjaga tanpa intervensi manual.
 */
export async function syncCatalog(rows: CatalogRow[]): Promise<SyncResult> {
  const result: SyncResult = { created: 0, updated: 0, skipped: [] };

  // Kalau satu brand+nominal muncul lebih dari sekali, yang termurah menang.
  const bestByKey = new Map<string, CatalogRow & { brand: Brand; nominal: number }>();

  for (const row of rows) {
    const brand = detectBrand(row.jenisId, row.kodeProduk);
    if (!brand) {
      result.skipped.push({
        kodeProduk: row.kodeProduk,
        reason: `jenis_id ${row.jenisId} bukan e-wallet yang didukung`,
      });
      continue;
    }

    const nominal = parseNominal(row.namaProduk, row.kodeProduk);
    if (nominal === null) {
      result.skipped.push({
        kodeProduk: row.kodeProduk,
        reason: 'nominal tidak bisa ditentukan',
      });
      continue;
    }

    // Harga modal di bawah nominal berarti data katalognya salah baca. Kalau
    // ini lolos, tiap transaksi jadi rugi, jadi lebih baik ditolak.
    if (row.basePrice < nominal) {
      result.skipped.push({
        kodeProduk: row.kodeProduk,
        reason: `harga modal ${row.basePrice} lebih kecil dari nominal ${nominal}`,
      });
      continue;
    }

    const key = `${brand}:${nominal}`;
    const current = bestByKey.get(key);
    if (!current || row.basePrice < current.basePrice) {
      bestByKey.set(key, { ...row, brand, nominal });
    }
  }

  for (const row of bestByKey.values()) {
    const sellPrice = calculateSellPrice(row.basePrice);

    // Dicari dulu lewat kodeProduk (kasus umum: produk yang sama, harga
    // berubah). Kalau tidak ketemu, dicoba lagi lewat brand+nominal --
    // supplier kadang mengganti kodeProduk untuk kombinasi brand+nominal yang
    // sama (mis. rotasi operator/skema harga), dan kolom itu constraint unik.
    // Tanpa fallback ini, create() gagal dengan "Unique constraint failed"
    // karena baris lama dengan kodeProduk berbeda masih menempati slot
    // brand+nominal tersebut -- sync pun berhenti di error itu setiap kali
    // dijalankan, bukan hanya sekali.
    const existing =
      (await prisma.product.findUnique({ where: { kodeProduk: row.kodeProduk } })) ??
      (await prisma.product.findUnique({
        where: { brand_nominal: { brand: row.brand, nominal: row.nominal } },
      }));

    const data = {
      jenisId: row.jenisId,
      brand: row.brand,
      namaProduk: `${BRAND_LABEL[row.brand]} ${row.nominal.toLocaleString('id-ID')}`,
      nominal: row.nominal,
      basePrice: row.basePrice,
      sellPrice,
      isActive: row.isActive,
      lastSyncedAt: new Date(),
    };

    if (existing) {
      // kodeProduk ikut ditimpa: kalau existing ditemukan lewat brand+nominal
      // dengan kodeProduk lama, baris itu tetap satu-satunya representasi
      // brand+nominal ini -- diperbarui ke kodeProduk baru, bukan dibuat baris
      // kedua yang akan bentrok dengan constraint unik.
      await prisma.product.update({
        where: { id: existing.id },
        data: { ...data, kodeProduk: row.kodeProduk },
      });
      result.updated += 1;
    } else {
      await prisma.product.create({ data: { ...data, kodeProduk: row.kodeProduk } });
      result.created += 1;
    }
  }

  logger.info(
    { created: result.created, updated: result.updated, skipped: result.skipped.length },
    'Sinkronisasi katalog selesai',
  );
  return result;
}

/** Menarik katalog langsung dari API supplier. */
export async function syncCatalogFromSupplier(): Promise<SyncResult> {
  const products = await supplier.listProducts();
  return syncCatalog(
    products.map((p) => ({
      kodeProduk: p.kodeProduk,
      jenisId: p.jenisId,
      namaProduk: p.namaProduk,
      basePrice: p.price,
      isActive: p.isActive,
    })),
  );
}

export async function listBrands() {
  const grouped = await prisma.product.groupBy({
    by: ['brand'],
    where: { isActive: true },
    _count: { _all: true },
    _min: { nominal: true },
    _max: { nominal: true },
  });

  return grouped.map((g) => ({
    brand: g.brand,
    label: BRAND_LABEL[g.brand as Brand] ?? g.brand,
    productCount: g._count._all,
    minNominal: g._min.nominal,
    maxNominal: g._max.nominal,
  }));
}

export async function listProducts(filter: { brand?: Brand }) {
  const products = await prisma.product.findMany({
    where: { isActive: true, ...(filter.brand ? { brand: filter.brand } : {}) },
    orderBy: [{ brand: 'asc' }, { nominal: 'asc' }],
    select: {
      kodeProduk: true,
      brand: true,
      nominal: true,
      sellPrice: true,
      namaProduk: true,
    },
  });

  // basePrice sengaja tidak pernah dikirim ke client -- itu harga modal.
  return products.map((p) => ({
    kodeProduk: p.kodeProduk,
    brand: p.brand,
    brandLabel: BRAND_LABEL[p.brand as Brand] ?? p.brand,
    name: p.namaProduk,
    nominal: p.nominal,
    price: p.sellPrice,
  }));
}
