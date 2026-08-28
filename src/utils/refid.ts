import { randomBytes } from 'node:crypto';

/**
 * Ref ID yang dikirim ke supplier. Harus unik selamanya — supplier memakainya
 * sebagai kunci idempotensi di sisi mereka.
 */
export function generateRefId(prefix = 'TRX'): string {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  return `${prefix}${stamp}${randomBytes(4).toString('hex').toUpperCase()}`;
}

export function generateInvoiceId(): string {
  return generateRefId('INV');
}
