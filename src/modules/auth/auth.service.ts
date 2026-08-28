import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { Role } from '../../domain/enums';
import { conflict, forbidden, notFound, unauthorized } from '../../lib/errors';
import { prisma } from '../../lib/prisma';

/** Label API key yang dibuat otomatis saat registrasi. */
const DEFAULT_API_KEY_LABEL = 'Default';

const BCRYPT_ROUNDS = 12;

export interface JwtPayload {
  sub: string;
  role: Role;
}

export function signToken(userId: string, role: Role): string {
  return jwt.sign({ sub: userId, role } satisfies JwtPayload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  } as jwt.SignOptions);
}

export function verifyToken(token: string): JwtPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET);
    if (typeof decoded === 'string' || !decoded.sub) {
      throw unauthorized('Token tidak valid');
    }
    return { sub: String(decoded.sub), role: (decoded as JwtPayload).role };
  } catch {
    throw unauthorized('Token tidak valid atau sudah kedaluwarsa');
  }
}

export async function register(input: {
  email: string;
  password: string;
  name: string;
  phone?: string;
}) {
  const email = input.email.toLowerCase().trim();

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw conflict('EMAIL_TAKEN', 'Email sudah terdaftar');
  }

  const user = await prisma.user.create({
    data: {
      email,
      name: input.name.trim(),
      phone: input.phone ?? null,
      passwordHash: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
      role: Role.USER,
    },
    select: { id: true, email: true, name: true, role: true, balance: true },
  });

  // Setiap akun langsung punya satu API key aktif sejak daftar, supaya
  // integrasi server-to-server tidak perlu langkah tambahan sebelum bisa
  // dipakai. Kalau raw value ini tidak ditangkap sekarang, tinggal
  // regenerateApiKey() -- key lama dicabut, key baru dibuat dengan label sama.
  const apiKey = await createApiKey(user.id, DEFAULT_API_KEY_LABEL);

  return { user, token: signToken(user.id, user.role as Role), apiKey };
}

export async function login(email: string, password: string) {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
  });

  // Pesan error sengaja disamakan untuk email tidak ada dan password salah,
  // supaya tidak bisa dipakai menebak email mana yang terdaftar.
  if (!user) throw unauthorized('Email atau password salah');

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw unauthorized('Email atau password salah');

  if (!user.isActive) throw forbidden('Akun dinonaktifkan');

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      balance: user.balance,
    },
    token: signToken(user.id, user.role as Role),
  };
}

// ---------------------------------------------------------------------------
// API key, untuk integrasi server-to-server
// ---------------------------------------------------------------------------

const API_KEY_PREFIX = 'sk_';

function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Key mentah hanya dikembalikan sekali di sini; database hanya menyimpan
 * hash-nya, jadi kebocoran isi tabel tidak langsung memberi akses.
 */
export async function createApiKey(userId: string, label: string) {
  const raw = `${API_KEY_PREFIX}${randomBytes(24).toString('hex')}`;

  const record = await prisma.apiKey.create({
    data: {
      userId,
      label,
      keyHash: hashApiKey(raw),
      keyPrefix: raw.slice(0, 10),
    },
    select: { id: true, label: true, keyPrefix: true, createdAt: true },
  });

  return { ...record, key: raw };
}

export async function resolveApiKey(raw: string) {
  const record = await prisma.apiKey.findUnique({
    where: { keyHash: hashApiKey(raw) },
    include: { user: true },
  });

  if (!record || record.revokedAt) throw unauthorized('API key tidak valid');
  if (!record.user.isActive) throw forbidden('Akun dinonaktifkan');

  // Sengaja tidak di-await: pembaruan jejak pemakaian tidak boleh menambah
  // latensi pada jalur transaksi.
  void prisma.apiKey
    .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  return record.user;
}

export async function revokeApiKey(userId: string, keyId: string) {
  await prisma.apiKey.updateMany({
    where: { id: keyId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Mengganti satu API key: cabut yang lama, buat yang baru dengan label sama.
 * Dipakai saat key lama bocor atau raw value-nya hilang (cuma ditampilkan
 * sekali saat dibuat). ID key berubah, jadi client harus menyimpan ulang.
 */
export async function regenerateApiKey(userId: string, keyId: string) {
  const existing = await prisma.apiKey.findFirst({
    where: { id: keyId, userId, revokedAt: null },
  });
  if (!existing) throw notFound('API key tidak ditemukan atau sudah dicabut');

  await prisma.apiKey.update({
    where: { id: existing.id },
    data: { revokedAt: new Date() },
  });

  return createApiKey(userId, existing.label);
}

export async function listApiKeys(userId: string) {
  return prisma.apiKey.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      label: true,
      keyPrefix: true,
      lastUsedAt: true,
      revokedAt: true,
      createdAt: true,
    },
  });
}
