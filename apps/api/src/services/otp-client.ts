/**
 * HTTP client for the quorum-otp service.
 *
 *   POST {OTP_SERVICE_URL}/v1/otps        → issue OTP (Polish WU v6 / A2)
 *   POST {OTP_SERVICE_URL}/v1/otps/verify → verify OTP
 *
 * The service uses HMAC-signed tokens (replay-resistant, ±60s skew window).
 * We translate the HTTP outcome into a VerifyOtpResult / IssueOtpResult the
 * service layer can branch on without leaking transport details.
 *
 * WU3b originally used this client as a verifier only (issuance happened
 * out-of-band via the operator console). Polish WU v6 adds `issue()` so
 * the backoffice can request a login OTP, receive the raw token back,
 * and deliver it to the user via the SMTP mailer (apps/api/src/services/
 * mailer.ts). The OTP service still owns the HMAC-signed transport
 * tokens, lockouts, replay protection, and rate limits.
 */
import type { VerifyOtpResult } from '@quorum-backoffice/shared';
import { AppError } from '../lib/errors';

interface OtpClientOptions {
  baseUrl: string;
  serviceToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Raw OTP token returned by `issue()`. The token is delivered ONCE to
 * the caller and never persisted by the OTP service — we forward it
 * to the user via the mailer and immediately forget it.
 */
export interface IssueOtpSuccess {
  ok: true;
  /** ULID/UUID assigned by the OTP service for audit traceability. */
  otpId: string;
  /** 6-char alphanumeric code to deliver to the user. */
  token: string;
  /** TTL in seconds the OTP service committed to. */
  ttlSeconds: number;
}

export interface IssueOtpFailure {
  ok: false;
  reason: 'rate_limited' | 'invalid_request' | 'service_error';
  /** Seconds the client should wait before retrying (only for rate_limited). */
  retryAfterSeconds?: number;
}

export type IssueOtpResult = IssueOtpSuccess | IssueOtpFailure;

export class OtpClient {
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: OtpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.serviceToken = opts.serviceToken;
    this.fetchImpl =
      opts.fetchImpl ??
      ((input: RequestInfo | URL, init?: RequestInit) => fetch(input as RequestInfo, init));
    this.timeoutMs = opts.timeoutMs ?? 5_000;
  }

  /**
   * Request a fresh OTP for (subject, scope). The returned `token` is
   * delivered once and must be sent to the user out-of-band (in our
   * case via the SMTP mailer). The OTP service rate-limits per service
   * token / IP / (subject, scope) — a 429 maps to `rate_limited` so
   * the auth service can back off.
   */
  async issue(args: {
    subject: string;
    scope: string;
    ttlSeconds?: number;
    maxAttempts?: number;
  }): Promise<IssueOtpResult> {
    const url = `${this.baseUrl}/v1/otps`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const body: Record<string, unknown> = {
        subject: args.subject,
        scope: args.scope,
      };
      if (typeof args.ttlSeconds === 'number') body['ttl_seconds'] = args.ttlSeconds;
      if (typeof args.maxAttempts === 'number') body['max_attempts'] = args.maxAttempts;

      const r = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.serviceToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });

      if (r.status === 201) {
        const parsed = (await r.json().catch(() => ({}))) as {
          id?: string;
          otp_id?: string;
          token?: string;
          ttl_seconds?: number;
        };
        if (!parsed.token) {
          return { ok: false, reason: 'service_error' };
        }
        return {
          ok: true,
          otpId: parsed.id ?? parsed.otp_id ?? 'unknown',
          token: parsed.token,
          ttlSeconds: parsed.ttl_seconds ?? args.ttlSeconds ?? 300,
        };
      }

      if (r.status === 429) {
        const retry = parseRetryAfter(r.headers.get('retry-after'));
        return { ok: false, reason: 'rate_limited', retryAfterSeconds: retry };
      }
      if (r.status === 400) {
        return { ok: false, reason: 'invalid_request' };
      }
      if (r.status >= 500) {
        throw AppError.serviceUnavailable(`otp_service_${r.status}`, { url });
      }
      return { ok: false, reason: 'service_error' };
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        throw AppError.serviceUnavailable('otp_service_timeout', { url, timeoutMs: this.timeoutMs });
      }
      if (err instanceof AppError) throw err;
      throw AppError.serviceUnavailable('otp_service_error', { url, message: (err as Error).message });
    } finally {
      clearTimeout(timer);
    }
  }

  async verify(args: {
    subject: string;
    scope: string;
    code: string;
  }): Promise<VerifyOtpResult> {
    const url = `${this.baseUrl}/v1/otps/verify`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const r = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.serviceToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ subject: args.subject, scope: args.scope, code: args.code }),
        signal: ac.signal,
      });

      if (r.status === 200) {
        const body = (await r.json().catch(() => ({}))) as { id?: string; otp_id?: string };
        const otpId = body.id ?? body.otp_id ?? 'unknown';
        return { ok: true, otpId };
      }

      if (r.status === 401 || r.status === 403) {
        return { ok: false, reason: 'invalid' };
      }
      if (r.status === 410 || r.status === 404) {
        return { ok: false, reason: 'expired' };
      }
      if (r.status === 423 || r.status === 429) {
        return { ok: false, reason: 'locked' };
      }
      if (r.status === 400) {
        return { ok: false, reason: 'invalid' };
      }
      if (r.status >= 500) {
        throw AppError.serviceUnavailable(`otp_service_${r.status}`, { url });
      }
      return { ok: false, reason: 'unknown' };
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        throw AppError.serviceUnavailable('otp_service_timeout', { url, timeoutMs: this.timeoutMs });
      }
      if (err instanceof AppError) throw err;
      throw AppError.serviceUnavailable('otp_service_error', { url, message: (err as Error).message });
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const asInt = Number.parseInt(header, 10);
  if (Number.isFinite(asInt) && asInt > 0) return asInt;
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) {
    const diff = Math.ceil((asDate - Date.now()) / 1000);
    return diff > 0 ? diff : undefined;
  }
  return undefined;
}
