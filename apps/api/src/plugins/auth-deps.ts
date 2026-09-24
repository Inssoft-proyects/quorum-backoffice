/**
 * Plugin: instantiates OtpClient + Mailer at app boot and decorates the
 * Fastify instance so route handlers can pick them up via `app.otpClient`
 * and `app.mailer`.
 *
 * Lives in plugins/ rather than services/ so the constructor wiring
 * (config + logger + a single mailer per process) is shared across
 * every handler and tested once via the integration suite.
 */
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { OtpClient } from '../services/otp-client';
import { createMailer, type Mailer } from '../services/mailer';

declare module 'fastify' {
  interface FastifyInstance {
    otpClient: OtpClient;
    mailer: Mailer;
  }
}

export default fp(async (app: FastifyInstance): Promise<void> => {
  const otpClient = new OtpClient({
    baseUrl: app.config.OTP_SERVICE_URL,
    serviceToken: app.config.OTP_SERVICE_TOKEN,
  });
  const mailer = createMailer(
    {
      SMTP_HOST: app.config.SMTP_HOST,
      SMTP_PORT: app.config.SMTP_PORT,
      SMTP_SECURE: app.config.SMTP_SECURE,
      SMTP_USER: app.config.SMTP_USER,
      SMTP_PASS: app.config.SMTP_PASS,
      SMTP_FROM: app.config.SMTP_FROM,
      NODE_ENV: app.config.NODE_ENV,
    },
    app.log,
  );
  app.decorate('otpClient', otpClient);
  app.decorate('mailer', mailer);
});