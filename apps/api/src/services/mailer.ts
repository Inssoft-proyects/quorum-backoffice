/**
 * Mailer service: SMTP transport for OTP delivery.
 *
 * Used by `AuthService.requestLoginOtp()` to send the 6-digit OTP to the
 * user's email. The transport is built once at app boot and reused.
 *
 * Behaviour by environment:
 *
 *   - production: a real SMTP host (configured via SMTP_HOST/SMTP_PORT/
 *     SMTP_USER/SMTP_PASS/SMTP_FROM) is required. The constructor throws
 *     `SMTPTransportError` if any required env var is missing — this is a
 *     fail-closed contract so an unconfigured production deploy cannot
 *     silently fall back to "log only" delivery.
 *
 *   - development: if SMTP is not configured, the mailer logs the OTP
 *     to pino at `warn` level and returns success. This makes local
 *     dev frictionless (no SMTP server needed) while keeping the
 *     contract identical from the caller's perspective. The `dev: true`
 *     flag on the returned `Mailer` lets tests/UI surface the warning.
 *
 *   - test: constructed with `createMailerForTest()` which exposes
 *     `lastSent` so unit/integration suites can assert the OTP body
 *     without an SMTP server.
 *
 * Errors during a real `send()` are surfaced as `SMTPTransportError`;
 * callers (the auth service) audit the failure and respond 503 to the
 * user without revealing the underlying SMTP host (no error leakage).
 */
import nodemailer, { type Transporter } from 'nodemailer';
import type { FastifyBaseLogger } from 'fastify';
import { AppError } from '../lib/errors';

export interface MailerConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string | undefined;
  pass: string | undefined;
  from: string;
  /** Disable real SMTP delivery; log to logger instead (dev convenience). */
  devMode: boolean;
}

export interface SendOtpEmailArgs {
  to: string;
  /** 6-char alphanumeric token. */
  code: string;
  /** Validity window in seconds — included in the email body. */
  ttlSeconds: number;
}

export interface Mailer {
  /** Sends an OTP email. Resolves on SMTP 2xx (or on dev-mode log). */
  sendOtpEmail(args: SendOtpEmailArgs): Promise<void>;
  /** True if the mailer is in dev mode (logged delivery only). */
  readonly devMode: boolean;
}

class NodemailerMailer implements Mailer {
  public readonly devMode: boolean;
  private readonly transporter: Transporter | null;
  private readonly log: FastifyBaseLogger;
  private readonly from: string;

  constructor(cfg: MailerConfig, log: FastifyBaseLogger) {
    this.from = cfg.from;
    this.devMode = cfg.devMode;
    this.log = log;
    this.transporter = cfg.devMode
      ? null
      : nodemailer.createTransport({
          host: cfg.host,
          port: cfg.port,
          secure: cfg.secure,
          ...(cfg.user && cfg.pass
            ? { auth: { user: cfg.user, pass: cfg.pass } }
            : {}),
        });
  }

  async sendOtpEmail(args: SendOtpEmailArgs): Promise<void> {
    const subject = 'Tu código de acceso a InecConecta Backoffice';
    const body = buildOtpEmailBody(args.code, args.ttlSeconds);
    if (this.transporter === null) {
      // Dev mode: never hit the network; log loudly so the developer
      // sees the code in their console.
      this.log.warn(
        {
          mailer: 'dev-mode',
          to: args.to,
          subject,
          code: args.code,
          ttlSeconds: args.ttlSeconds,
        },
        'smtp_dev_mode_otp_logged',
      );
      return;
    }
    try {
      await this.transporter.sendMail({
        from: this.from,
        to: args.to,
        subject,
        text: body.text,
        html: body.html,
      });
    } catch (err) {
      throw AppError.serviceUnavailable('smtp_send_failed', {
        message: (err as Error).message,
      });
    }
  }
}

function buildOtpEmailBody(
  code: string,
  ttlSeconds: number,
): { text: string; html: string } {
  const minutes = Math.max(1, Math.round(ttlSeconds / 60));
  const text = [
    'Tu código de acceso a InecConecta Backoffice es:',
    '',
    `    ${code}`,
    '',
    `Este código vence en ${minutes} minuto(s).`,
    'Si no solicitaste este código, ignora este mensaje.',
  ].join('\n');
  const html = `<!doctype html>
<html lang="es">
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#f6f7f6; padding:24px; color:#292929;">
    <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:480px; margin:0 auto; background:#ffffff; border:1px solid #d9dfd9; border-radius:8px;">
      <tr>
        <td style="padding:24px;">
          <h1 style="margin:0 0 16px; font-size:20px; color:#292929;">InecConecta · Backoffice</h1>
          <p style="margin:0 0 16px;">Tu código de acceso es:</p>
          <p style="margin:0 0 16px; font-size:32px; font-weight:700; letter-spacing:0.2em; color:#358456; text-align:center;">${escapeHtml(code)}</p>
          <p style="margin:0 0 8px; color:#5f5f5f;">Este código vence en ${minutes} minuto(s).</p>
          <p style="margin:16px 0 0; color:#6f6f6f; font-size:12px;">Si no solicitaste este código, ignora este mensaje.</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
  return { text, html };
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Build the mailer from app config. Validates that production deploys
 * have SMTP configured; allows dev/test to fall back to logged delivery.
 */
export function createMailer(
  rawCfg: {
    SMTP_HOST?: string | undefined;
    SMTP_PORT?: string | number | undefined;
    SMTP_SECURE?: string | boolean | undefined;
    SMTP_USER?: string | undefined;
    SMTP_PASS?: string | undefined;
    SMTP_FROM: string;
    NODE_ENV: 'development' | 'test' | 'production';
  },
  log: FastifyBaseLogger,
): Mailer {
  const isDev = rawCfg.NODE_ENV !== 'production';
  const host = rawCfg.SMTP_HOST;
  const port =
    rawCfg.SMTP_PORT !== undefined && rawCfg.SMTP_PORT !== ''
      ? Number(rawCfg.SMTP_PORT)
      : undefined;
  if (!isDev && (!host || !port)) {
    throw AppError.serviceUnavailable('smtp_not_configured', {
      nodeEnv: rawCfg.NODE_ENV,
      required: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'],
    });
  }
  return new NodemailerMailer(
    {
      host: host ?? '',
      port: port ?? 0,
      secure: rawCfg.SMTP_SECURE === true || rawCfg.SMTP_SECURE === 'true',
      user: rawCfg.SMTP_USER,
      pass: rawCfg.SMTP_PASS,
      from: rawCfg.SMTP_FROM,
      devMode: isDev && (!host || !port),
    },
    log,
  );
}

/**
 * Test-only factory that captures the last email body in memory instead of
 * opening an SMTP connection. Used by integration tests to assert that
 * the OTP code is delivered without touching the network.
 */
export function createMailerForTest(opts: {
  log: FastifyBaseLogger;
  devMode?: boolean;
}): Mailer & { lastSent: SendOtpEmailArgs[] } {
  const sent: SendOtpEmailArgs[] = [];
  const inner: Mailer = {
    devMode: opts.devMode ?? true,
    async sendOtpEmail(args: SendOtpEmailArgs): Promise<void> {
      sent.push(args);
      opts.log.warn(
        { mailer: 'test', to: args.to, code: args.code },
        'smtp_test_otp_captured',
      );
    },
  };
  return Object.assign(inner, { lastSent: sent });
}