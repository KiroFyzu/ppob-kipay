import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { logger } from '../src/lib/logger';
import { prisma } from '../src/lib/prisma';

/**
 * Menyetel ulang password sebuah akun.
 *
 *   npm run reset:password -- admin@ppob.local                 -> password acak
 *   npm run reset:password -- admin@ppob.local PasswordBaru123 -> password sendiri
 *
 * Dibutuhkan karena password yang dibuat seed-admin hanya ditampilkan sekali
 * dan yang tersimpan cuma hash bcrypt. Begitu hilang, tidak ada cara membacanya
 * kembali -- satu-satunya jalan adalah menimpanya.
 */

/** Sama dengan aturan pendaftaran di web.routes.ts, supaya tidak ada pintu belakang. */
const MIN_LENGTH = 8;
const MAX_LENGTH = 128;

async function main(): Promise<void> {
  const email = process.argv[2]?.toLowerCase();
  const supplied = process.argv[3];

  if (!email) {
    console.error('\nEmail wajib disebutkan.');
    console.error('  npm run reset:password -- admin@ppob.local\n');
    process.exitCode = 1;
    return;
  }

  if (supplied !== undefined) {
    if (supplied.length < MIN_LENGTH || supplied.length > MAX_LENGTH) {
      console.error(
        `\nPassword harus ${MIN_LENGTH}-${MAX_LENGTH} karakter. Yang diberikan: ${supplied.length}.\n`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    const all = await prisma.user.findMany({
      select: { email: true, role: true },
      orderBy: { createdAt: 'asc' },
    });
    console.error(`\nAkun ${email} tidak ditemukan. Yang ada di database:`);
    for (const row of all) console.error(`  ${row.role.padEnd(6)} ${row.email}`);
    console.error('');
    process.exitCode = 1;
    return;
  }

  // Password acak dipakai kalau tidak disebutkan, supaya tidak ada yang tergoda
  // memakai password tebakan seperti "admin123" hanya karena sedang buru-buru.
  const password = supplied ?? randomBytes(12).toString('base64url');

  await prisma.user.update({
    where: { email },
    data: { passwordHash: await bcrypt.hash(password, 12) },
  });

  console.log('\n=== Password disetel ulang ===');
  console.log(`  Email    : ${user.email}`);
  console.log(`  Role     : ${user.role}`);
  console.log(`  Password : ${password}`);
  console.log('\n  Simpan sekarang, password ini tidak ditampilkan lagi.\n');
}

main()
  .catch((err) => {
    logger.error({ err }, 'Gagal menyetel ulang password');
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
