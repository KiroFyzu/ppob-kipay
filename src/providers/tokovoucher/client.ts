import { createHash } from 'node:crypto';
import { setDefaultResultOrder } from 'node:dns';
import { env } from '../../config/env';
import { BANK_CODE } from '../../domain/enums';
import { logger } from '../../lib/logger';
import {
  BankTransferParams,
  OrderParams,
  SupplierBalance,
  SupplierOrderResult,
  SupplierProduct,
  SupplierProvider,
  SupplierStatus,
  SupplierUnavailableError,
} from './types';

// ===========================================================================
// Status verifikasi terhadap API TokoVoucher (dicocokkan ulang dengan
// docs.tokovoucher.net setelah IP di-whitelist, 26 Agustus 2026)
// ---------------------------------------------------------------------------
// SUDAH TERBUKTI BENAR / DICOCOKKAN DENGAN DOKUMENTASI RESMI:
//   - Base URL https://api.tokovoucher.net
//   - accountSignature() = md5(member_code:signature_key) -> dipakai untuk
//     endpoint tanpa ref_id: /member (saldo), /member/produk/full (katalog).
//     Amplopnya dibungkus "data": {"status":1,"data":{...}}.
//   - signature(refId) = md5(member_code:signature_key:ref_id) -> dipakai
//     untuk /v1/transaksi (order) dan /v1/transaksi/status (cek status).
//     Respons endpoint ini TIDAK dibungkus "data" -- field status, trx_id,
//     sn, ref_id, produk, sisa_saldo, price semuanya ada di level teratas.
//   - Endpoint transaksi butuh POST + Content-Type application/json.
//     GET menjawab "Data not valid !!", form-urlencoded menjawab
//     "JSON not valid !!". Lihat catatan di request().
//   - Amplop error (IP not allowed / signature invalid) memakai
//     {"status":0,"error_msg":"..."} -- angka 0, beda dari status transaksi
//     yang berupa string "sukses"/"pending"/"gagal". assertEnvelopeOk() hanya
//     menolak saat status bernilai 0 (angka), sehingga tidak pernah tertukar
//     dengan status "gagal" (transaksi ditolak, bukan request-nya).
// ===========================================================================

/**
 * Memaksa koneksi keluar lewat IPv4.
 *
 * TokoVoucher menyaring berdasarkan IP, dan IPv6 rumahan di Windows adalah
 * privacy address yang berganti sendiri secara berkala -- alamat yang hari ini
 * di-whitelist besok sudah tidak berlaku. IPv4 publik jauh lebih stabil, jadi
 * itu yang dipakai. Tanpa baris ini Node memilih IPv6 lebih dulu dan seluruh
 * transaksi ditolak dengan "IP Not Allowed" meskipun IPv4-nya sudah terdaftar.
 */
setDefaultResultOrder('ipv4first');

const ENDPOINTS = {
  order: '/v1/transaksi',
  status: '/v1/transaksi/status',
  balance: '/member',
  products: '/member/produk/full',
  transferBank: '/v1/transfer/bank',
} as const;

const REQUEST_TIMEOUT_MS = 30_000;

/** Signature TokoVoucher: md5(member_code:signature_key:ref_id). */
function signature(refId: string): string {
  return createHash('md5')
    .update(`${env.TOKOVOUCHER_MEMBER_CODE}:${env.TOKOVOUCHER_SIGNATURE_KEY}:${refId}`)
    .digest('hex');
}

/** Signature untuk endpoint tanpa ref_id, contohnya cek saldo. */
function accountSignature(): string {
  return createHash('md5')
    .update(`${env.TOKOVOUCHER_MEMBER_CODE}:${env.TOKOVOUCHER_SIGNATURE_KEY}`)
    .digest('hex');
}

type RawResponse = Record<string, unknown>;

/**
 * Endpoint transaksi TokoVoucher HANYA menerima POST dengan body JSON.
 *
 * Ini bukan preferensi gaya. Dikirim sebagai GET dengan query string, server
 * menjawab "Data not valid !!" tanpa memeriksa satu pun parameter -- bahkan
 * member_code yang sengaja dipalsukan pun menghasilkan pesan yang sama. Kirim
 * sebagai POST form-urlencoded, jawabannya "JSON not valid !!". Baru dengan
 * POST + Content-Type application/json permintaan sampai ke lapisan otentikasi.
 *
 * Endpoint akun (/member) tetap dilayani lewat GET.
 */
async function request(
  path: string,
  params: Record<string, string | number>,
  method: 'GET' | 'POST' = 'POST',
): Promise<RawResponse> {
  const url = new URL(path, env.TOKOVOUCHER_BASE_URL);
  if (method === 'GET') {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers:
        method === 'POST'
          ? { Accept: 'application/json', 'Content-Type': 'application/json' }
          : { Accept: 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify(params) } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    throw new SupplierUnavailableError(
      `Tidak bisa menghubungi TokoVoucher (${path})`,
      err,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();

  if (!res.ok) {
    throw new SupplierUnavailableError(
      `TokoVoucher membalas HTTP ${res.status} untuk ${path}`,
      text.slice(0, 500),
    );
  }

  let parsed: RawResponse;
  try {
    parsed = JSON.parse(text) as RawResponse;
  } catch {
    throw new SupplierUnavailableError(
      `Respons TokoVoucher bukan JSON yang valid untuk ${path}`,
      text.slice(0, 500),
    );
  }

  assertEnvelopeOk(parsed, path);
  return parsed;
}

/**
 * Memetakan beragam istilah status supplier ke tiga status internal.
 *
 * Aturan paling penting di file ini: apa pun yang TIDAK dikenali dipetakan ke
 * 'pending', bukan 'failed'. Menebak 'failed' berarti kita me-refund user
 * padahal saldonya mungkin sudah benar-benar terkirim, dan itu kerugian
 * langsung yang tidak bisa ditarik balik. 'pending' hanya menunda keputusan,
 * dan worker akan memeriksanya lagi.
 */
function mapStatus(raw: unknown): SupplierStatus {
  const value = String(raw ?? '').toLowerCase().trim();

  if (['sukses', 'success', 'berhasil', '1', 'true'].includes(value)) {
    return 'success';
  }
  if (['gagal', 'failed', 'error', 'batal', 'cancel', 'canceled', '2'].includes(value)) {
    return 'failed';
  }
  if (['pending', 'proses', 'process', 'processing', 'diproses', '0'].includes(value)) {
    return 'pending';
  }

  logger.warn({ rawStatus: raw }, 'Status supplier tidak dikenali, dianggap pending');
  return 'pending';
}

function pickString(obj: RawResponse, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return null;
}

function pickNumber(obj: RawResponse, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const asNumber = Number(value);
    if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(asNumber)) {
      return asNumber;
    }
  }
  return null;
}

/**
 * Membongkar amplop respons "data" -- dipakai HANYA oleh endpoint yang
 * benar-benar membungkusnya: /member (saldo) dan /member/produk/full
 * (katalog). Endpoint transaksi (/v1/transaksi, /v1/transaksi/status) TIDAK
 * memakai amplop ini; field-nya ada langsung di level teratas, lihat
 * parseOrderResult().
 */
function unwrapData(res: RawResponse): RawResponse | null {
  const data = res['data'];
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return data as RawResponse;
  }
  return null;
}

/**
 * Menolak amplop error TokoVoucher: {"status":0,"rc":500,"error_msg":"..."}.
 *
 * Tanpa pemeriksaan ini, `status: 0` terbaca sebagai status transaksi "0" yang
 * berarti pending, dan `error_msg` tidak pernah terbaca sama sekali. Akibatnya
 * kesalahan konfigurasi seperti IP yang belum di-whitelist tampak seperti
 * transaksi yang sedang diproses: saldo user sudah dipotong, order tidak
 * pernah masuk ke supplier, dan tidak ada satu pun pesan yang menjelaskannya.
 */
function assertEnvelopeOk(res: RawResponse, path: string): void {
  const status = res['status'];
  if (status !== 0 && status !== '0') return;

  const reason = pickString(res, 'error_msg', 'message', 'msg') ?? 'tanpa keterangan';
  const rc = pickString(res, 'rc') ?? '-';

  throw new SupplierUnavailableError(
    `TokoVoucher menolak ${path}: ${reason} (rc=${rc})`,
    res,
  );
}

/**
 * Mengurai respons /v1/transaksi dan /v1/transaksi/status.
 *
 * Berbeda dari /member dan /member/produk/full, endpoint ini TIDAK membungkus
 * isinya di dalam "data" -- field `status` di level teratas ADALAH status
 * transaksi yang sebenarnya ("sukses" | "pending" | "gagal"), bukan status
 * amplop. Amplop error (IP not allowed, signature invalid) sudah disaring
 * lebih dulu oleh assertEnvelopeOk() lewat cek `status === 0` (angka, bukan
 * string), jadi begitu sampai di sini status yang tersisa selalu berupa
 * salah satu dari tiga nilai transaksi di atas.
 */
function parseOrderResult(res: RawResponse): SupplierOrderResult {
  const statusRaw = pickString(res, 'status', 'status_code', 'trx_status', 'message_status');

  return {
    status: mapStatus(statusRaw ?? ''),
    trxId: pickString(res, 'trx_id', 'trxid', 'id_transaksi', 'transaction_id'),
    serialNumber: pickString(res, 'sn', 'serial_number', 'serial', 'note'),
    message:
      pickString(res, 'message', 'msg', 'keterangan', 'ket', 'error_msg') ?? 'Tanpa keterangan',
    price: pickNumber(res, 'price', 'harga', 'nominal_harga'),
    raw: res,
  };
}

export class TokoVoucherClient implements SupplierProvider {
  readonly name = 'tokovoucher';

  async order({
    refId,
    kodeProduk,
    targetNumber,
  }: OrderParams): Promise<SupplierOrderResult> {
    logger.info({ refId, kodeProduk }, 'Mengirim order ke TokoVoucher');

    const res = await request(ENDPOINTS.order, {
      member_code: env.TOKOVOUCHER_MEMBER_CODE,
      signature: signature(refId),
      ref_id: refId,
      produk: kodeProduk,
      tujuan: targetNumber,
    });

    return parseOrderResult(res);
  }

  /**
   * docs.tokovoucher.net/bank-transfer -- kirim saldo ke rekening bank.
   *
   * Amplop respons SAMA seperti /v1/transaksi: tidak dibungkus "data", dan
   * dicek lewat endpoint /v1/transaksi/status yang sama (checkStatus() di
   * atas dipakai apa adanya, tidak ada endpoint status terpisah untuk
   * transfer bank).
   */
  async transferBank({
    refId,
    bankCode,
    accountNumber,
    nominal,
  }: BankTransferParams): Promise<SupplierOrderResult> {
    // TokoVoucher wajib bank_code numerik (mis. "014"), bukan bank_id ("bca")
    // yang kita simpan/pakai di UI -- lihat BANK_CODE di domain/enums.ts.
    // Kode yang belum ada di map diteruskan apa adanya supaya bank baru masih
    // bisa dicoba tanpa deploy, dengan risiko ditolak TokoVoucher.
    const supplierBankCode = BANK_CODE[bankCode] ?? bankCode;
    logger.info({ refId, bankCode, supplierBankCode }, 'Mengirim transfer bank ke TokoVoucher');

    const res = await request(ENDPOINTS.transferBank, {
      member_code: env.TOKOVOUCHER_MEMBER_CODE,
      signature: signature(refId),
      ref_id: refId,
      bank: supplierBankCode,
      tujuan: accountNumber,
      nominal,
    });

    return parseOrderResult(res);
  }

  async checkStatus(refId: string): Promise<SupplierOrderResult> {
    const res = await request(ENDPOINTS.status, {
      member_code: env.TOKOVOUCHER_MEMBER_CODE,
      signature: signature(refId),
      ref_id: refId,
    });
    return parseOrderResult(res);
  }

  async getBalance(): Promise<SupplierBalance> {
    const res = await request(
      ENDPOINTS.balance,
      {
        member_code: env.TOKOVOUCHER_MEMBER_CODE,
        signature: accountSignature(),
      },
      'GET',
    );
    const body = unwrapData(res) ?? res;
    return { balance: pickNumber(body, 'saldo', 'balance') ?? 0, raw: res };
  }

  /**
   * Menarik seluruh katalog lewat /member/produk/full.
   *
   * Responsnya dibungkus "data" seperti /member, tapi bentuknya bukan array
   * langsung -- "data" berisi objek dengan empat kunci (category, operator,
   * jenis, produk); yang dibutuhkan di sini hanya "produk".
   */
  async listProducts(): Promise<SupplierProduct[]> {
    const res = await request(
      ENDPOINTS.products,
      {
        member_code: env.TOKOVOUCHER_MEMBER_CODE,
        signature: accountSignature(),
      },
      'GET',
    );

    const body = unwrapData(res);
    const data = body?.['produk'];
    if (!Array.isArray(data)) {
      throw new SupplierUnavailableError(
        'Daftar produk TokoVoucher (field data.produk) tidak berbentuk array',
        res,
      );
    }

    return data.flatMap((item): SupplierProduct[] => {
      if (!item || typeof item !== 'object') return [];
      const row = item as RawResponse;

      const kodeProduk = pickString(row, 'kode_produk', 'code', 'kode');
      const price = pickNumber(row, 'price', 'harga');
      const jenisId = pickNumber(row, 'jenis_id', 'id_jenis');
      if (!kodeProduk || price === null || jenisId === null) return [];

      const statusRaw = row['status'];
      return [
        {
          kodeProduk,
          jenisId,
          namaProduk: pickString(row, 'nama_produk', 'nama', 'name') ?? kodeProduk,
          price,
          isActive: statusRaw === undefined || mapStatus(statusRaw) !== 'failed',
          raw: row,
        },
      ];
    });
  }
}
