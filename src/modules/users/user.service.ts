import { badRequest, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';

/**
 * Manajemen akun pengguna untuk panel admin. Lihat juga
 * modules/balance/ledger.service.ts::auditBalance untuk audit saldo per user,
 * dan modules/transactions/fraud.service.ts untuk blokir per nomor/rekening
 * -- tiga hal berbeda, sengaja tidak digabung jadi satu modul "admin".
 */

export async function listUsers(options: { limit: number }) {
  return prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    take: options.limit,
    select: {
      id: true,
      email: true,
      name: true,
      phone: true,
      role: true,
      isActive: true,
      balance: true,
      createdAt: true,
    },
  });
}

/**
 * Mengaktifkan/menonaktifkan akun. Akun nonaktif tidak bisa login maupun
 * dipakai API key-nya -- lihat pengecekan isActive di auth.service.ts
 * (login) dan resolveApiKey().
 */
export async function setUserActive(
  actingAdminId: string,
  userId: string,
  isActive: boolean,
) {
  if (!isActive && userId === actingAdminId) {
    throw badRequest(
      'CANNOT_DEACTIVATE_SELF',
      'Kamu tidak bisa menonaktifkan akunmu sendiri.',
    );
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound('Pengguna tidak ditemukan');

  return prisma.user.update({
    where: { id: userId },
    data: { isActive },
    select: { id: true, email: true, isActive: true },
  });
}
