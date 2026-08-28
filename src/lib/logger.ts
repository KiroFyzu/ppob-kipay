import pino from 'pino';
import { env } from '../config/env';

export const logger = pino({
  level: env.LOG_LEVEL,
  transport:
    env.NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss',
            // Satu baris per log. Default pino-pretty mencetak tiap field di
            // baris sendiri -- bagus untuk log yang jarang, tapi bikin satu
            // event sederhana ("saldo dipotong") memenuhi setengah layar.
            singleLine: true,
            // pid dan hostname sama untuk semua baris di satu proses; tidak
            // menambah informasi, hanya menggeser pesan yang penting.
            ignore: 'pid,hostname',
          },
        }
      : undefined,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      'password',
      '*.passwordHash',
      'signature',
      '*.signature',
    ],
    censor: '[redacted]',
  },
});
