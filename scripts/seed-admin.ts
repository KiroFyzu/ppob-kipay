import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Role } from '../src/domain/enums';
import { logger } from '../src/lib/logger';
import { prisma } from '../src/lib/prisma';

/**
 * Membuat akun admin pertama.
 *
 *   npm run seed:admin -- admin@contoh.com
 *
 * Password dibuat acak dan hanya ditampilkan sekali di terminal. Password
 * default yang bisa ditebak adalah cara paling umum sistem seperti ini
 * dibobol, jadi tidak disediakan.
 */
async function main(): Promise<void> {
  const email = (process.argv[2] ?? 'admin@localhost').toLowerCase();
  const password = randomBytes(12).toString('base64url');

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`\nAkun ${email} sudah ada. Tidak ada yang diubah.\n`);
    return;
  }

  const user = await prisma.user.create({
    data: {
      email,
      name: 'Administrator',
      passwordHash: await bcrypt.hash(password, 12),
      role: Role.ADMIN,
    },
  });

  console.log('\n=== Akun admin dibuat ===');
  console.log(`  Email    : ${user.email}`);
  console.log(`  Password : ${password}`);
  console.log('\n  Simpan sekarang, password ini tidak ditampilkan lagi.\n');
}

main()
  .catch((err) => {
    logger.error({ err }, 'Gagal membuat akun admin');
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
