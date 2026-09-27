/**
 * HTTP client for the quorum-otp service.
 *
 * Only `verify` is exposed. Issuing OTPs is intentionally NOT a
 * BackOffice concern: the user arrives with a pre-issued code (e.g.
 * delivered by their authenticator, by a sister system, or by a
 * kiosk-style flow). BackOffice verifies it and exchanges it for a
 * session cookie.
 *
 * Provider contract (verified by source inspection of
 * `/planQuorum/dev/quorum-otp/src/routes/otp.ts` and
 * `/planQuorum/dev/quorum-otp/src/plugins/auth.ts`):
 *
 *   - Transport header:
 *       `Authorization: HMAC <service-name> <unix-timestamp> <hex-signature>`
 *   - Signature:
 *       `HMAC-SHA256(secret, "${timestamp}.${exactRawJsonBody}")`
 *   - Verify request body field is `token`, NOT `code`:
 *       `{ subject, scope, token }`
 *   - Verify success: `200 { valid: true, otp_id, consumed_at }`
 *   - Verify rejection (replay / wrong token / expired / locked OTP /
 *     locked subject-scope): `409 { error.code = 'verify_rejected' }`
 *   - Verify rate-limited: `429 { error.code = 'rate_limited' }`
 *   - Provider auth failure: `401` / `403` (bad header, unknown service,
 *     signature mismatch, stale timestamp beyond skew window).
 *
 * The client translates the HTTP outcome into `VerifyOtpResult`
 * without leaking transport details to the caller. Provider
 * 401/403 means "credential/config problem on OUR side" and is
 * surfaced as `service_unavailable` — it must NEVER be confused
 * with "the user's OTP is wrong". Provider 409 means "the OTP is
 * genuinely rejected" and is mapped to `invalid`.
 */
import type { VerifyOtpResult } from '@quorum-backoffice/shared';
import { AppError } from '../lib/errors';

interface OtpClientOptions {
  baseUrl: string;
  /** Shared HMAC secret. */
  serviceToken: string;
  /**
   * Service identity asserted on the `Authorization: HMAC <name> ...`
   * header. quorum-otp uses this to look up the secret for signature
   * verification, so it must match the registration on the provider
   * side. The default is `quorum-backoffice`.
   */
  serviceName?: string;
  /** Maximum allowed clock skew in seconds (default 60 — matches quorum-otp). */
  clockSkewSeconds?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Override the wall-clock provider for deterministic tests. */
  now?: () => number;
}

interface Sender {
  send: (args: {
    method: 'POST' | 'GET';
    url: string;
    body: string;
    headers: Record<string, string>;
  }) => Promise<Response>;
}

/**
 * Thin async wrapper around fetch that owns the timeout + header
 * shape so every request the HMAC client issues goes through the
 * same code path. The exact raw JSON body string is captured
 * BEFORE the wire transport adds headers, and the HMAC signature is
 * computed against the SAME byte stream. Tests override `fetchImpl`
 * to capture the wire bytes for assertion.
 */
function createDefaultSender(fetchImpl: typeof fetch, timeoutMs: number): Sender {
  return {
    async send({ method, url, body, headers }) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        return await fetchImpl(url, {
          method,
          headers,
          body,
          signal: ac.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export class OtpClient {
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly serviceName: string;
  /** Cached clock skew tolerance — exposed for tests/diagnostics. */
  public readonly clockSkewSeconds: number;
  private readonly sender: Sender;
  /** Timestamp provider — defaults to Date.now(); tests override to assert wire bytes. */
  private readonly now: () => number;

  constructor(opts: OtpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.serviceToken = opts.serviceToken;
    this.serviceName = opts.serviceName ?? 'quorum-backoffice';
    this.clockSkewSeconds = opts.clockSkewSeconds ?? 60;
    this.now = opts.now ?? (() => Date.now());
    const fetchImpl =
      opts.fetchImpl ??
      ((input: RequestInfo | URL, init?: RequestInit) => fetch(input as RequestInfo, init));
    this.sender = createDefaultSender(fetchImpl, opts.timeoutMs ?? 5_000);
  }

  /**
   * Verify a pre-issued OTP for `(subject, scope)` against the
   * quorum-otp service.
   *
   * Returns `VerifyOtpResult` (domain-level). On transport failures
   * (timeout, network) throws `AppError.serviceUnavailable`. On
   * provider auth failures (401/403) throws `service_unavailable`:
   * these mean the BackOffice HMAC identity is not correctly
   * registered with the provider, NOT that the user's OTP is wrong.
   *
   * The user-visible "invalid OTP" path is reserved exclusively for
   * the provider's 409 / 423 outcome.
   *
   * Note: the TypeScript argument is named `code` for compatibility
   * with the rest of the BackOffice (login + destructive-ops routes
   * share the same client). The provider reads the field as
   * `token` on the wire; the client translates internally so the
   * caller can keep using `code` regardless of which route is
   * sending the call.
   */
  async verify(args: { subject: string; scope: string; code: string }): Promise<VerifyOtpResult> {
    const subject = args.subject.trim();
    const scope = args.scope.trim();
    const token = args.code.trim();
    if (!subject || !scope || !token) {
      throw AppError.badRequest('verify_otp_invalid_args');
    }

    // Exact raw body the wire will carry — used in the HMAC signature
    // AND sent verbatim so receiver and sender agree on the bytes.
    // The field name on the wire is `token` (NOT `code`) per the
    // quorum-otp contract (see /planQuorum/dev/quorum-otp/src/routes/otp.ts).
    const rawBody = JSON.stringify({ subject, scope, token });
    const timestamp = Math.floor(this.now() / 1000).toString();
    const signature = await OtpClient.computeSignature({
      secret: this.serviceToken,
      timestamp,
      rawBody,
    });
    const authorization = `HMAC ${this.serviceName} ${timestamp} ${signature}`;
    const url = `${this.baseUrl}/v1/otps/verify`;

    let response: Response;
    try {
      response = await this.sender.send({
        method: 'POST',
        url,
        body: rawBody,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization,
        },
      });
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        throw AppError.serviceUnavailable('otp_service_timeout', { url });
      }
      throw AppError.serviceUnavailable('otp_service_error', {
        url,
        message: (err as Error).message,
      });
    }

    // Provider auth failures MUST be treated as dependency
    // misconfiguration, never as "the user's OTP is wrong".
    if (response.status === 401 || response.status === 403) {
      throw AppError.serviceUnavailable('otp_service_unauthorized', {
        url,
        status: response.status,
      });
    }

    if (response.status === 200) {
      const body = (await response.json().catch(() => ({}))) as {
        id?: string;
        otp_id?: string;
        valid?: boolean;
      };
      if (body.valid !== true) {
        // The 200 status with valid !== true is an unexpected shape —
        // surface as dependency failure rather than silently treating
        // it as a "valid OTP" for the caller.
        throw AppError.serviceUnavailable('otp_service_unexpected_body', {
          url,
          body: { id: body.id, otp_id: body.otp_id, valid: body.valid },
        });
      }
      const otpId = body.id ?? body.otp_id ?? 'unknown';
      return { ok: true, otpId };
    }

    // 409 verify_rejected is the canonical "wrong / replayed /
    // expired / locked OTP" outcome.
    if (response.status === 409 || response.status === 423) {
      return { ok: false, reason: 'invalid' };
    }

    // Rate-limit responses get a dedicated reason so the auth layer
    // can keep the user posted with a retry hint.
    if (response.status === 429) {
      return { ok: false, reason: 'locked' };
    }

    // 400 — the request itself was malformed (e.g. empty `subject`).
    // Treat as invalid because retrying with the same payload will
    // not change anything.
    if (response.status === 400) {
      return { ok: false, reason: 'invalid' };
    }

    // 5xx — provider outage.
    if (response.status >= 500) {
      throw AppError.serviceUnavailable('otp_service_5xx', {
        url,
        status: response.status,
      });
    }

    return { ok: false, reason: 'unknown' };
  }

  /**
   * Compute the HMAC-SHA256 signature the provider expects:
   *   `HMAC_SHA256(secret, "${timestamp}.${rawBody}")`
   * encoded as lowercase hex. Implementation is pure Node so it works
   * identically in jest (node test) and at runtime. Exposed as a
   * static so tests can assert wire bytes against a known secret.
   */
  static async computeSignature(args: {
    secret: string;
    timestamp: string;
    rawBody: string;
  }): Promise<string> {
    // Use Node's webcrypto so we don't pull another dependency just
    // for one HMAC. Node ≥18 ships a global SubtleCrypto.
    const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
    if (!subtle) {
      throw new Error('hmac_subtle_crypto_unavailable');
    }
    const enc = new TextEncoder();
    const keyMaterial = enc.encode(args.secret);
    const signingPayload = enc.encode(`${args.timestamp}.${args.rawBody}`);

    // SubtleCrypto.importKey supports raw HMAC keys.
    const key = await subtle.importKey(
      'raw',
      keyMaterial,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sigBuf = await subtle.sign('HMAC', key, signingPayload);
    return OtpClient.toHex(new Uint8Array(sigBuf));
  }

  /** Lowercase hex encoder compatible with Node's Uint8Array output. */
  static toHex(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i += 1) {
      out += bytes[i]!.toString(16).padStart(2, '0');
    }
    return out;
  }

  /** Test-only hook: read back the resolved configuration. */
  describe(): {
    baseUrl: string;
    serviceName: string;
    clockSkewSeconds: number;
  } {
    return {
      baseUrl: this.baseUrl,
      serviceName: this.serviceName,
      clockSkewSeconds: this.clockSkewSeconds,
    };
  }
}
