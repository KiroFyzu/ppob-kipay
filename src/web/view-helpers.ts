import { DepositStatus, TxStatus } from '../domain/enums';

/**
 * Fungsi bantu yang dipasang ke app.locals sehingga bisa dipanggil langsung
 * dari template EJS. Pemformatan dikumpulkan di sini supaya angka rupiah dan
 * tanggal tampil seragam di seluruh halaman.
 */

export function rupiah(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '-';
  return `Rp${amount.toLocaleString('id-ID')}`;
}

export function tanggal(value: Date | string | null | undefined): string {
  if (!value) return '-';
  const date = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Jakarta',
  }).format(date);
}

/** Kelas CSS untuk lencana status. Dipetakan eksplisit, bukan ditebak dari string. */
export function statusClass(status: string): string {
  switch (status) {
    case TxStatus.SUCCESS:
    case DepositStatus.PAID:
      return 'badge badge-success';
    case TxStatus.PENDING:
    case TxStatus.PROCESSING:
    case DepositStatus.PENDING:
      return 'badge badge-pending';
    case TxStatus.REFUNDED:
      return 'badge badge-refund';
    case TxStatus.FAILED:
    case DepositStatus.FAILED:
    case DepositStatus.EXPIRED:
      return 'badge badge-failed';
    default:
      return 'badge';
  }
}

/** Label status dalam bahasa yang dimengerti pengguna, bukan istilah internal. */
export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    PENDING: 'Menunggu',
    PROCESSING: 'Diproses',
    SUCCESS: 'Berhasil',
    FAILED: 'Gagal',
    REFUNDED: 'Dikembalikan',
    PAID: 'Lunas',
    EXPIRED: 'Kedaluwarsa',
  };
  return labels[status] ?? status;
}

export function brandClass(brand: string): string {
  return `brand-${brand.toLowerCase()}`;
}

export const viewHelpers = {
  rupiah,
  tanggal,
  statusClass,
  statusLabel,
  brandClass,
};
