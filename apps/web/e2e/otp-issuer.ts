import { createHmac } from 'node:crypto';

/**
 * Out-of-band OTP issuer for the E2E suites.
 *
 * The BackOffice consumes single-use OTPs issued by the sibling
 * `quorum-otp` service. In production the codes are delivered to the
 * user (SMTP / operator channel); in E2E they are issued directly by
 * this helper against a reachable `quorum-otp` instance, using the same
 * HMAC service-token wire format the BackOffice API itself speaks:
 *
 *   Authorization: HMAC <service-name> <unix-timestamp> <hex-signature>
 *   signature = HMAC-SHA256(secret, "<timestamp>.<rawBody>")
 *
 * Environment:
 *   E2E_OTP_URL            — quorum-otp base URL (default http://127.0.0.1:8085)
 *   E2E_OTP_SERVICE_NAME   — service name registered in OTP_SERVICE_TOKENS
 *   E2E_OTP_SERVICE_TOKEN  — HMAC secret for that name (REQUIRED; suites
 *                            must skip when it is absent)
 *
 * OTP subjects differ per flow and MUST match what the API sends:
 *   - login:               subject = canonical username (lower-case), scope 'login'
 *   - destructive actions: subject = the actor's EMAIL, scope 'dispositivo.*'
 *   - access decision:     subject = String(canvas_user_id), scope 'access.decision'
 */

const OTP_URL = (process.env['E2E_OTP_URL'] ?? 'http://127.0.0.1:8085').replace(/\/$/, '');
const OTP_SERVICE_NAME = process.env['E2E_OTP_SERVICE_NAME'] ?? 'e2e-service';
const OTP_SERVICE_TOKEN = process.env['E2E_OTP_SERVICE_TOKEN'] ?? '';

export function otpEnvReady(): boolean {
  return OTP_SERVICE_TOKEN.length > 0;
}

/** Builds the `Authorization: HMAC …` header for an exact raw body. */
export function serviceAuth(rawBody: string): string {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac('sha256', OTP_SERVICE_TOKEN)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return `HMAC ${OTP_SERVICE_NAME} ${timestamp} ${signature}`;
}

/**
 * Issues a single-use OTP for (subject, scope) and returns its token.
 * Throws on any non-201 so a broken issuer surfaces as a hard failure
 * instead of a confusing login/assignment error later in the flow.
 */
export async function issueOtp(
  subject: string,
  scope: string,
  ttlSeconds = 300,
): Promise<string> {
  const rawBody = JSON.stringify({ subject, scope, ttl_seconds: ttlSeconds });
  const res = await fetch(`${OTP_URL}/v1/otps`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: serviceAuth(rawBody),
    },
    body: rawBody,
  });
  if (res.status !== 201) {
    throw new Error(`issueOtp(${subject}, ${scope}) failed: HTTP ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { token?: string };
  if (!body.token) {
    throw new Error(`issueOtp(${subject}, ${scope}) returned no token`);
  }
  return body.token;
}

/** Signs a JSON body for POST /api/v1/access-decisions (machine caller).
 *
 * The access-decision endpoint authenticates against
 * `BACKOFFICE_SERVICE_TOKENS` (the caller registry), NOT the OTP
 * service registry — separate names and secrets.
 *
 * Environment:
 *   E2E_CALLER_NAME   — caller name registered in BACKOFFICE_SERVICE_TOKENS
 *   E2E_CALLER_TOKEN  — HMAC secret for that caller
 */
export function signedAccessDecision(body: Record<string, unknown>): {
  authorization: string;
  rawBody: string;
} {
  const name = process.env['E2E_CALLER_NAME'] ?? 'demo-caller';
  const secret = process.env['E2E_CALLER_TOKEN'] ?? 'demo-secret';
  const rawBody = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return { authorization: `HMAC ${name} ${timestamp} ${signature}`, rawBody };
}
