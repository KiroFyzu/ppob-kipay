import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { KipayStatus, KipayTransaction, KipayUnavailableError } from './types';

const REQUEST_TIMEOUT_MS = 15_000;

type RawResponse = Record<string, unknown>;

async function request(path: string, init: RequestInit): Promise<RawResponse> {
  const url = new URL(path, env.KIPAY_BASE_URL);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...init.headers },
      signal: controller.signal,
    });
  } catch (err) {
    throw new KipayUnavailableError(`Tidak bisa menghubungi KiPay (${path})`, err);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let parsed: RawResponse;
  try {
    parsed = text ? (JSON.parse(text) as RawResponse) : {};
  } catch {
    throw new KipayUnavailableError(
      `Respons KiPay bukan JSON yang valid untuk ${path}`,
      text.slice(0, 500),
    );
  }

  if (!res.ok) {
    const reason = typeof parsed['error'] === 'string' ? parsed['error'] : `HTTP ${res.status}`;
    throw new KipayUnavailableError(`KiPay menolak ${path}: ${reason}`, parsed);
  }

  return parsed;
}

/**
 * KiPay mengirim timestamp tanpa penanda zona waktu, contoh "2026-08-26
 * 06:50:08" (lihat contoh payload webhook.paid: matched_at itu berselisih
 * ~2 detik dari sent_at yang eksplisit UTC -- jadi nilainya UTC, cuma
 * formatnya bukan ISO 8601 baku).
 *
 * `new Date("2026-08-26 06:50:08")` TIDAK boleh dipakai langsung: string
 * tanpa 'T'/'Z' diparse sebagai waktu LOKAL server (timezone proses Node),
 * bukan UTC. Di server dengan timezone selain UTC, itu menggeser hasilnya
 * diam-diam -- misalnya expiredAt bisa muncul lebih awal dari createdAt.
 * Ubah ke bentuk ISO UTC eksplisit dulu sebelum diparse.
 */
function parseKipayTimestamp(raw: unknown): Date | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const date = new Date(`${raw.trim().replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function mapTransaction(raw: RawResponse): KipayTransaction {
  return {
    trxId: String(raw['trx_id']),
    mode: raw['mode'] === 'production' ? 'production' : 'sandbox',
    requestedAmount: Number(raw['requested_amount']),
    uniqueCode: Number(raw['unique_code']),
    amount: Number(raw['amount']),
    feeAmount: Number(raw['fee_amount'] ?? 0),
    netAmount: Number(raw['net_amount'] ?? 0),
    status: (['pending', 'paid', 'expired'] as KipayStatus[]).includes(
      raw['status'] as KipayStatus,
    )
      ? (raw['status'] as KipayStatus)
      : 'pending',
    provider: typeof raw['provider'] === 'string' ? raw['provider'] : null,
    qrPayload: typeof raw['qr_payload'] === 'string' ? raw['qr_payload'] : null,
    matchedAt: parseKipayTimestamp(raw['matched_at']),
    createdAt: parseKipayTimestamp(raw['created_at']) ?? new Date(),
    expiresAt: parseKipayTimestamp(raw['expires_at']),
    raw,
  };
}

function assertConfigured(): void {
  if (!env.KIPAY_API_KEY) {
    throw new KipayUnavailableError('KIPAY_API_KEY belum dikonfigurasi');
  }
}

/** kipay.id/docs -- POST /api/pay/{apiKey}/transactions */
export async function createKipayTransaction(
  amount: number,
  note?: string,
): Promise<KipayTransaction> {
  assertConfigured();
  const res = await request(`/api/pay/${env.KIPAY_API_KEY}/transactions`, {
    method: 'POST',
    body: JSON.stringify({ amount, ...(note ? { note } : {}) }),
  });
  return mapTransaction(res);
}

/** GET /api/pay/{apiKey}/transactions/{trxId} -- dipakai untuk polling status. */
export async function getKipayTransaction(trxId: string): Promise<KipayTransaction> {
  assertConfigured();
  const res = await request(
    `/api/pay/${env.KIPAY_API_KEY}/transactions/${encodeURIComponent(trxId)}`,
    { method: 'GET' },
  );
  return mapTransaction(res);
}

/**
 * Mengambil gambar QR (PNG) langsung dari KiPay untuk diteruskan ke client.
 * Diproxy lewat backend kita supaya KIPAY_API_KEY tidak pernah dikirim ke
 * browser -- meskipun api_key KiPay didesain "publik" (dipakai di URL
 * halaman /pay/:apiKey mereka sendiri), aplikasi ini menyimpan seluruh
 * kredensial supplier di sisi server saja, konsisten dengan TokoVoucher.
 */
export async function fetchKipayQrImage(trxId: string): Promise<Buffer> {
  assertConfigured();
  const url = new URL(
    `/api/pay/${env.KIPAY_API_KEY}/transactions/${encodeURIComponent(trxId)}/qr.png`,
    env.KIPAY_BASE_URL,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    throw new KipayUnavailableError('Tidak bisa mengambil gambar QR dari KiPay', err);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new KipayUnavailableError(`KiPay membalas HTTP ${res.status} untuk gambar QR`);
  }

  return Buffer.from(await res.arrayBuffer());
}

/**
 * Verifikasi webhook KiPay (kipay.id/docs, bagian Outgoing Webhook).
 *
 * Header X-Webhook-Signature berisi "sha256=" + HMAC-SHA256(rawBody, secret).
 * WAJIB dihitung dari raw body, bukan JSON.stringify(req.body) -- urutan key
 * atau spasi yang berbeda menghasilkan HMAC yang berbeda pula.
 */
export function verifyKipaySignature(rawBody: string, received: string | undefined): boolean {
  if (!env.KIPAY_WEBHOOK_SECRET) {
    logger.error('KIPAY_WEBHOOK_SECRET belum diisi, callback ditolak');
    return false;
  }
  if (!received) return false;

  const expected =
    'sha256=' + createHmac('sha256', env.KIPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}
