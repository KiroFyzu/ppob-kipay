import { Brand } from '../domain/enums';
import { badRequest } from '../lib/errors';

/**
 * Normalisasi nomor Indonesia ke format lokal 0xxx.
 * Menerima 08xx, 62 8xx, +62 8xx, dan variasi dengan spasi/strip.
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[\s\-().]/g, '');

  let local: string;
  if (digits.startsWith('+62')) local = `0${digits.slice(3)}`;
  else if (digits.startsWith('62')) local = `0${digits.slice(2)}`;
  else if (digits.startsWith('8')) local = `0${digits}`;
  else local = digits;

  if (!/^0\d{8,13}$/.test(local)) {
    throw badRequest(
      'INVALID_TARGET_NUMBER',
      'Nomor tujuan tidak valid. Gunakan format 08xxxxxxxxxx.',
    );
  }
  return local;
}

/**
 * Prefix operator seluler Indonesia yang masih aktif dialokasikan.
 * DANA, OVO, dan GoPay terikat ke nomor seluler, jadi nomor telepon rumah atau
 * prefix tak dikenal ditolak sebelum uang bergerak.
 */
const CELLULAR_PREFIXES = [
  // Telkomsel
  '0811', '0812', '0813', '0821', '0822', '0823', '0851', '0852', '0853',
  // Indosat
  '0814', '0815', '0816', '0855', '0856', '0857', '0858',
  // XL / Axis
  '0817', '0818', '0819', '0859', '0877', '0878', '0831', '0832', '0833', '0838',
  // Tri
  '0895', '0896', '0897', '0898', '0899',
  // Smartfren
  '0881', '0882', '0883', '0884', '0885', '0886', '0887', '0888', '0889',
];

export function assertValidTarget(brand: Brand, normalized: string): void {
  const prefix = normalized.slice(0, 4);
  if (!CELLULAR_PREFIXES.includes(prefix)) {
    throw badRequest(
      'UNKNOWN_OPERATOR_PREFIX',
      `Prefix ${prefix} bukan nomor seluler yang dikenali. Periksa kembali nomor tujuan.`,
    );
  }

  // ShopeePay memakai nomor yang terdaftar di akun Shopee, panjangnya sama
  // dengan nomor seluler biasa, jadi tidak ada aturan tambahan di sini.
  // Blok ini sengaja dibiarkan eksplisit agar mudah ditambah aturan per brand.
  void brand;
}

/** Menutup sebagian nomor untuk log dan respons publik: 0812****7890 */
export function maskPhone(normalized: string): string {
  if (normalized.length < 8) return normalized;
  return `${normalized.slice(0, 4)}****${normalized.slice(-4)}`;
}
