/**
 * Plugin: instantiate the OtpClient at app boot and decorate the
 * Fastify instance so route handlers can pick it up via `app.otpClient`.
 *
 * The BackOffice no longer issues OTPs and does not need an SMTP
 * mailer at boot. The only responsibility at boot is wiring the
 * HMAC-authenticated OTP client used by `AuthService.loginWithOtp`.
 *
 * Service identity (`OTP_SERVICE_NAME`) defaults to `quorum-backoffice`
 * to match the registered HMAC key on the quorum-otp side; operators
 * can override it per-environment via env.
 *
 * Lives in plugins/ rather than services/ so the constructor wiring
 * (config + logger + a single OTP client per process) is shared
 * across every handler and tested once via the integration suite.
 */
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { OtpClient } from '../services/otp-client';

declare module 'fastify' {
  interface FastifyInstance {
    otpClient: OtpClient;
  }
}

export default fp(async (app: FastifyInstance): Promise<void> => {
  const otpClient = new OtpClient({
    baseUrl: app.config.OTP_SERVICE_URL,
    serviceToken: app.config.OTP_SERVICE_TOKEN,
    serviceName: app.config.OTP_SERVICE_NAME,
  });
  app.decorate('otpClient', otpClient);
});
