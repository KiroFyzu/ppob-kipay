/**
 * Error aplikasi dengan kode yang stabil. Kode ini bagian dari kontrak API —
 * client boleh mengandalkannya, jadi jangan diubah sembarangan.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);

export const unauthorized = (message = 'Autentikasi diperlukan') =>
  new AppError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'Akses ditolak') =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (message = 'Data tidak ditemukan') =>
  new AppError(404, 'NOT_FOUND', message);

export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);

export const tooManyRequests = (code: string, message: string, details?: unknown) =>
  new AppError(429, code, message, details);

export const upstreamError = (message: string, details?: unknown) =>
  new AppError(502, 'UPSTREAM_ERROR', message, details);
