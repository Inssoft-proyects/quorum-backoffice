import pino from 'pino';
import type { Config } from '../config';

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.otp',
  '*.otpCode',
  '*.serial_number',
  '*.marbete_uid',
  '*.sessionSecret',
];

export function createLogger(config: Config): pino.Logger {
  return pino({
    level: config.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    base: { service: 'quorum-backoffice-api', env: config.NODE_ENV },
    transport:
      config.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss.l', colorize: true } }
        : undefined,
  });
}

export type Logger = pino.Logger;
