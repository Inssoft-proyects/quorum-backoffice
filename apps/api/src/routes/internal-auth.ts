/**
 * S2S identity verification for Quorum QR.
 *
 * `POST /api/v1/internal/auth/verify-otp` validates a username + OTP
 * pair and returns the user identity **without issuing a backoffice
 * session or cookie**. The caller (quorum-qr) authenticates with HMAC
 * service auth (`Authorization: HMAC quorum-qr <ts> <sig>`) and then
 * mints its own session.
 *
 * It reuses AuthService's verification path, so the per-username login
 * attempt counter, OTP provider and failure audit are shared with the
 * normal login route. A successful call writes `auth.verify_service`
 * with the calling service in `entityId`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { LoginRequestOtp } from '@quorum-backoffice/shared';
import { parseServiceTokens, requireServiceAuth } from '../plugins/service-auth';
import { AuthService } from '../services/auth-service';
import { createAuthService } from './auth';

function metaFromRequest(req: FastifyRequest): { ip: string | null; userAgent: string | null } {
  return {
    ip: req.ip ?? null,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  };
}

export async function registerInternalAuthRoutes(
  app: FastifyInstance,
  deps?: { authService?: AuthService },
): Promise<void> {
  const registry = parseServiceTokens({
    BACKOFFICE_SERVICE_TOKENS: app.config.BACKOFFICE_SERVICE_TOKENS,
  });
  const preHandler = requireServiceAuth({
    registry,
    skewSeconds: app.config.BACKOFFICE_SERVICE_HMAC_SKEW_SECONDS,
  });

  app.post('/api/v1/internal/auth/verify-otp', { preHandler }, async (req) => {
    const body = LoginRequestOtp.parse(req.body);
    const svc = deps?.authService ?? createAuthService(app);
    const user = await svc.verifyOtpIdentity(
      body.username,
      body.otp,
      metaFromRequest(req),
      req.serviceCaller ?? 'unknown',
    );

    return {
      user: {
        id: user.id,
        username: user.username,
        displayName: user.username,
        role: user.role,
      },
    };
  });
}
