import { z } from 'zod';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  API_PORT: z.coerce.number().int().positive().default(3100),
  API_HOST: z.string().default('127.0.0.1'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  OTP_SERVICE_URL: z.string().url(),
  /** Shared HMAC secret used to sign every request to the OTP service. */
  OTP_SERVICE_TOKEN: z.string().min(8),
  /**
   * Service identity asserted on the `Authorization: HMAC <service-name> ...`
   * header sent to the quorum-otp service. Defaults to `quorum-backoffice`
   * so existing HMAC keys provisioned under that name continue to work
   * out-of-the-box; operators can override it when the BackOffice
   * instance is registered under a different service identity in
   * quorum-otp (e.g. multiple BackOffice replicas / environments).
   */
  OTP_SERVICE_NAME: z.string().min(1).max(64).default('quorum-backoffice'),

  CANVAS_PORTAL_API_URL: z.string().url(),
  CANVAS_PORTAL_API_TOKEN: z.string().min(8),

  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 chars'),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

  AUTH_COOKIE_NAME: z.string().default('sid'),
  AUTH_COOKIE_SECURE: z.coerce.boolean().default(true),
  AUTH_LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  AUTH_LOGIN_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),

  // Login OTP tuning. The OTP itself is owned by the quorum-otp
  // service (HMAC-signed), so the BackOffice only exposes the
  // session/attempt knobs the API itself enforces.
  LOGIN_OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_OTP_REQUEST_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),

  /**
   * 20-minute OTP grant window for destructive marbete operations.
   *
   * When an admin verifies a fresh single-use 6-digit OTP against
   * quorum-otp for a grant-eligible scope (today: `marbete.create`,
   * `marbete.update`, `marbete.delete`, `marbete.bulk_create`), the
   * BackOffice records a grant row that lets the actor skip the
   * per-op OTP verify for this many minutes. `marbete.reveal` is
   * intentionally NOT grant-eligible.
   *
   * Stored as minutes for readability; converted to milliseconds at
   * use site (see OtpGrantService). Operators set this per
   * environment — production may want a longer or shorter window
   * depending on operational risk tolerance.
   */
  OTP_GRANT_TTL_MINUTES: z.coerce.number().int().positive().default(20),

  ALLOWED_ORIGIN: z.string().url().optional(),

  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(8).optional(),

  // Service-auth (B3.1): inbound HMAC-authenticated callers
  // (e.g. the Canvas pipeline, the Jitsi join coordinator) are
  // registered here as `name:secret,name:secret`. The plugin
  // `requireServiceAuth()` parses this and rejects every call
  // when the parsed registry is empty, so an unset / empty
  // env var fails closed at the request boundary. We keep the
  // field optional in the schema so pre-existing test fixtures
  // (rbac.test.ts, dispositivos.test.ts, ...) that don't set it
  // continue to boot; production deployments MUST set it
  // before the `/api/v1/access/decision` route goes live (B3.2).
  BACKOFFICE_SERVICE_TOKENS: z.string().default(''),
  BACKOFFICE_SERVICE_HMAC_SKEW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60),

  // M3 / MFA SSO redirect: comma-separated allowlist of Canvas
  // origins (protocol + host + port) that the MFA web page may
  // redirect the student to. The MFA web page calls
  // POST /api/v1/mfa/redirect-token with the `next_url`; the
  // route parses the URL, extracts the origin, and compares it
  // against this allowlist using constant-time string compare.
  // The SAME allowlist is consulted on the consume path so a
  // token issued for an allowlisted origin cannot be replayed
  // against a different origin. Empty / missing → every
  // `next_url` is rejected with 403 mfa_redirect_origin_not_allowed
  // (fail-closed).
  MFA_ALLOWED_REDIRECT_ORIGINS: z.string().default(''),
});

export type Config = z.infer<typeof ConfigSchema>;

let cached: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = result.data;
  return cached;
}

export function resetConfigForTests(): void {
  cached = null;
}
