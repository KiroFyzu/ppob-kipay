import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from '../src/lib/logger';
import { prisma } from '../src/lib/prisma';
import { CatalogRow, syncCatalog } from '../src/modules/products/product.service';

/**
 * Mengimpor katalog dari file CSV ekspor TokoVoucher.
 *
 *   npm run seed:products                       -> pakai harga-produk-tokovoucher.csv
 *   npm run seed:products -- path/ke/file.csv   -> pakai file lain
 *
 * Dipakai selama endpoint daftar produk supplier belum diverifikasi. Setelah
 * itu, katalog bisa disegarkan lewat POST /api/v1/admin/products/sync yang
 * menarik langsung dari API.
 */

const DEFAULT_CSV = 'harga-produk-tokovoucher.csv';

/** Parser CSV minimal yang menghormati tanda kutip. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
}

function loadCsv(path: string): CatalogRow[] {
  const content = readFileSync(path, 'utf8');
  const lines = content.split(/\r?\n/).filter((l) => l.trim() !== '');

  const header = parseCsvLine(lines[0] ?? '').map((h) => h.toLowerCase());
  const indexOf = (name: string): number => header.indexOf(name);

  const idx = {
    jenisId: indexOf('jenis_id'),
    kodeProduk: indexOf('kode_produk'),
    namaProduk: indexOf('nama_produk'),
    harga: indexOf('harga'),
  };

  const missing = Object.entries(idx)
    .filter(([, value]) => value === -1)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(
      `Kolom CSV tidak lengkap. Tidak ditemukan: ${missing.join(', ')}. ` +
        `Header yang terbaca: ${header.join(', ')}`,
    );
  }

  const rows: CatalogRow[] = [];

  for (const line of lines.slice(1)) {
    const fields = parseCsvLine(line);
    const kodeProduk = fields[idx.kodeProduk];
    const harga = Number(fields[idx.harga]);
    const jenisId = Number(fields[idx.jenisId]);

    if (!kodeProduk || !Number.isFinite(harga) || !Number.isFinite(jenisId)) {
      logger.warn({ line }, 'Baris CSV dilewati, data tidak lengkap');
      continue;
    }

    rows.push({
      kodeProduk,
      jenisId,
      namaProduk: fields[idx.namaProduk] ?? kodeProduk,
      basePrice: Math.round(harga),
      isActive: true,
    });
  }

  return rows;
}

async function main(): Promise<void> {
  const target = process.argv[2] ?? DEFAULT_CSV;
  const path = resolve(process.cwd(), target);

  logger.info({ path }, 'Membaca katalog dari CSV');
  const rows = loadCsv(path);
  logger.info({ count: rows.length }, 'Baris CSV terbaca');

  const result = await syncCatalog(rows);

  console.log('\n=== Hasil impor katalog ===');
  console.log(`  Produk baru    : ${result.created}`);
  console.log(`  Produk diubah  : ${result.updated}`);
  console.log(`  Dilewati       : ${result.skipped.length}`);

  if (result.skipped.length > 0) {
    console.log('\n  Detail yang dilewati:');
    for (const item of result.skipped.slice(0, 20)) {
      console.log(`    - ${item.kodeProduk}: ${item.reason}`);
    }
    if (result.skipped.length > 20) {
      console.log(`    ... dan ${result.skipped.length - 20} lainnya`);
    }
  }

  const summary = await prisma.product.groupBy({
    by: ['brand'],
    _count: { _all: true },
    _min: { nominal: true },
    _max: { nominal: true },
  });

  console.log('\n  Katalog aktif per brand:');
  for (const row of summary) {
    console.log(
      `    ${row.brand.padEnd(10)} ${String(row._count._all).padStart(3)} produk ` +
        `(${row._min.nominal?.toLocaleString('id-ID')} - ${row._max.nominal?.toLocaleString('id-ID')})`,
    );
  }
  console.log('');
}

main()
  .catch((err) => {
    logger.error({ err }, 'Impor katalog gagal');
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
