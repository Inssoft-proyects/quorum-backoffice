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

  ALLOWED_ORIGIN: z.string().url().optional(),

  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(8).optional(),
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
