import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Menyalin views dan public ke dalam dist.
 *
 * tsc hanya memindahkan file .ts, sedangkan template EJS dan aset statis tidak
 * ikut. Kode di src/http/app.ts mencari keduanya relatif terhadap lokasi file
 * yang sedang berjalan, jadi setelah build isinya harus ada di dist -- kalau
 * tidak, server produksi jalan tapi setiap halaman gagal dirender.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

for (const folder of ['views', 'public']) {
  const from = join(root, folder);
  const to = join(root, 'dist', folder);

  if (!existsSync(from)) {
    console.error(`  ! ${folder}/ tidak ditemukan, dilewati`);
    continue;
  }

  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  console.log(`  ok  ${folder}/ -> dist/${folder}/`);
}
