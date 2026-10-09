/**
 * Fastify plugin: inbound HMAC service-auth for the
 * Canvas/Jitsi federated access feature.
 *
 * The BackOffice exposes a `POST /api/v1/access/decision` endpoint
 * (B3.2) that other services call to obtain an allow/deny
 * decision. The caller must present a valid HMAC-SHA256 signature
 * over the exact request body bytes using a shared secret
 * registered in the `BACKOFFICE_SERVICE_TOKENS` env var.
 *
 * Two pieces are exported:
 *
 *   1. `captureRawBodyPlugin` — registers a content-type parser
 *      that stashes the exact raw body string on the request
 *      (`req.rawBody`) BEFORE JSON parse, so the HMAC verifier
 *      can sign the same bytes the sender signed. This mirrors
 *      `quorum-otp`'s `captureRawBodyPlugin` in
 *      /planQuorum/dev/quorum-otp/src/plugins/auth.ts:60.
 *
 *   2. `requireServiceAuth({ registry, skewSeconds })` — a
 *      preHandler factory that validates the
 *      `Authorization: HMAC <service-name> <unix-ts> <hex-sig>`
 *      header. Every failure mode is collapsed into a single
 *      `deny.idp_untrusted` 401 response so the wire envelope
 *      never leaks the specific reason (avoids letting an
 *      attacker probe the registry by status code). On success
 *      the request is decorated with `req.serviceCaller =
 *      <service-name>`.
 *
 * The plugin is dependency-injected: it does not touch `app.config`
 * directly. `app.ts` (or the future B3.2 route registration)
 * resolves the config and calls the factory with the parsed
 * registry + skew. This keeps the plugin unit-testable without
 * booting the full app.
 */
import fp from 'fastify-plugin';
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
  preHandlerHookHandler,
} from 'fastify';
import { hmacVerify } from '../lib/service-hmac';
import { AppError } from '../lib/errors';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The raw body string captured before JSON parse. Set by
     * `captureRawBodyPlugin`; consumed by `requireServiceAuth`
     * and any other plugin that needs the wire bytes (e.g. an
     * idempotency key). Defaults to the empty string when the
     * capture plugin is not registered.
     */
    rawBody?: string;
    /**
     * The authenticated service name. Set by `requireServiceAuth`
     * on success; handlers can use it to attribute audit / lockout
     * side effects to the calling service.
     */
    serviceCaller?: string;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The wire prefix every valid `Authorization` header must carry.
 * Mirrors quorum-otp's `Authorization: HMAC <name> <ts> <hex>` scheme.
 */
const HMAC_PREFIX = 'HMAC ';

// ---------------------------------------------------------------------------
// Token registry parsing
// ---------------------------------------------------------------------------

/**
 * Parsed service-tokens env (`BACKOFFICE_SERVICE_TOKENS=name:secret,name:secret`).
 *
 * Tolerant of trailing commas, whitespace, and secrets that contain
 * a colon (only the FIRST colon splits, so a secret like
 * `abc:def` is preserved verbatim). Entries without a colon are
 * silently dropped — they cannot resolve to a registry entry and
 * silently ignoring them matches quorum-otp's `parseServiceTokens`
 * behavior.
 *
 * Returns an empty Map for an empty/whitespace-only env so the
 * preHandler can fail closed at the call site.
 */
export function parseServiceTokens(config: { BACKOFFICE_SERVICE_TOKENS: string }): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of config.BACKOFFICE_SERVICE_TOKENS.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) continue;
    const name = trimmed.slice(0, idx);
    const secret = trimmed.slice(idx + 1);
    out.set(name, secret);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Raw-body capture plugin
// ---------------------------------------------------------------------------

/**
 * Stash the exact raw body string on `req.rawBody` BEFORE the
 * default JSON parser runs. Mirrors quorum-otp's
 * `captureRawBodyPlugin` byte-for-byte. The HMAC verifier signs
 * over the same bytes the sender signed, so any whitespace
 * normalization done by a higher-level parser would break the
 * signature.
 */
export const captureRawBodyPlugin: FastifyPluginAsync = fp(
  async (app: FastifyInstance): Promise<void> => {
    app.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (req, body: string, done) => {
        (req as unknown as { rawBody: string }).rawBody = body;
        try {
          const parsed = body.length === 0 ? undefined : JSON.parse(body);
          done(null, parsed);
        } catch (err) {
          done(err as Error, undefined);
        }
      },
    );
  },
  { name: 'service-auth-raw-body' },
);

// ---------------------------------------------------------------------------
// requireServiceAuth preHandler factory
// ---------------------------------------------------------------------------

export interface RequireServiceAuthOptions {
  /**
   * Service-name → shared-secret map. Pre-parsed by
   * `parseServiceTokens`. An empty map causes every call to be
   * rejected (`fail-closed`).
   */
  registry: Map<string, string>;
  /**
   * Maximum allowed `|now - timestamp|` in seconds. Matches the
   * default skew used by quorum-otp (60s).
   */
  skewSeconds: number;
}

/**
 * Build a Fastify preHandler that authenticates the caller using
 * the HMAC-SHA256 wire format. Every failure mode is collapsed
 * into `AppError('deny.idp_untrusted', <message>, 401)`.
 *
 * Failure modes (all map to the same 401 envelope to avoid
 * information leakage):
 *   - Missing `Authorization` header
 *   - Header does not start with `HMAC `
 *   - Header has the wrong number of whitespace-separated parts
 *   - Timestamp is not a finite number
 *   - Service name is not in the registry
 *   - Empty registry (fail-closed)
 *   - Timestamp is outside the ±skew window
 *   - Signature does not match (tampered body, wrong secret,
 *     malformed signature, etc.)
 *
 * On success the request is decorated with `req.serviceCaller =
 * <service-name>` so handlers can attribute side effects.
 */
export function requireServiceAuth(opts: RequireServiceAuthOptions): preHandlerHookHandler {
  const { registry, skewSeconds } = opts;

  return async function serviceAuthPreHandler(req: FastifyRequest): Promise<void> {
    // Fail-closed: an empty registry must reject every call.
    // This is the second line of defense — the env-validator
    // already requires a non-empty BACKOFFICE_SERVICE_TOKENS at
    // boot, but a misconfigured deploy that slips through must
    // never silently allow traffic.
    if (registry.size === 0) {
      throw new AppError('deny.idp_untrusted', 'service token registry is empty', 401);
    }

    const header = req.headers.authorization;
    if (!header || !header.startsWith(HMAC_PREFIX)) {
      throw new AppError('deny.idp_untrusted', 'service token required', 401);
    }

    const parts = header.slice(HMAC_PREFIX.length).split(/\s+/);
    if (parts.length !== 3) {
      throw new AppError('deny.idp_untrusted', 'malformed service token header', 401);
    }

    const [name, timestampStr, signature] = parts as [string, string, string];
    const timestamp = Number(timestampStr);
    if (!Number.isFinite(timestamp)) {
      throw new AppError('deny.idp_untrusted', 'malformed service token timestamp', 401);
    }

    const secret = registry.get(name);
    if (!secret) {
      throw new AppError('deny.idp_untrusted', 'unknown service token', 401);
    }

    // `captureRawBodyPlugin` stashes the exact body bytes; fall
    // back to an empty string for requests with no body (GET /
    // no-payload POST). The HMAC verifier signs the same empty
    // string in that case so the round-trip works.
    const body = req.rawBody ?? '';

    if (!hmacVerify(secret, timestamp, body, signature, skewSeconds)) {
      throw new AppError('deny.idp_untrusted', 'service token signature failed', 401);
    }

    req.serviceCaller = name;
  };
}
