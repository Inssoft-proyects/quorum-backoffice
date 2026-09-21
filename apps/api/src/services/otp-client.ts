/**
 * HTTP client for the quorum-otp service.
 *
 *   POST {OTP_SERVICE_URL}/v1/otps/verify → 200 OK on success, 4xx on failure
 *
 * The service uses HMAC-signed tokens (replay-resistant, ±60s skew window).
 * We translate the HTTP outcome into a VerifyOtpResult the service layer can
 * branch on without leaking transport details.
 *
 * In WU3b the service is **only** a verifier (no issue/revoke) — issuance
 * happens out-of-band (operator console or another channel) before the
 * backoffice is asked to authorize a destructive action.
 */
import type { VerifyOtpResult } from '@quorum-backoffice/shared';
import { AppError } from '../lib/errors';

interface OtpClientOptions {
  baseUrl: string;
  serviceToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

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
