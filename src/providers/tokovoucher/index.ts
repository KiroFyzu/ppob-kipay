import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { TokoVoucherClient } from './client';
import { MockSupplierClient } from './mock';
import { SupplierProvider } from './types';

export * from './types';

/**
 * Satu-satunya tempat aplikasi memilih supplier. Service lain mengimpor
 * `supplier` dari sini dan tidak pernah tahu implementasi mana yang aktif.
 */
export const supplier: SupplierProvider =
  env.TOKOVOUCHER_MODE === 'mock' ? new MockSupplierClient() : new TokoVoucherClient();

if (env.TOKOVOUCHER_MODE === 'mock') {
  logger.warn(
    'TOKOVOUCHER_MODE=mock aktif. Tidak ada transaksi yang benar-benar dikirim ke supplier.',
  );
}
