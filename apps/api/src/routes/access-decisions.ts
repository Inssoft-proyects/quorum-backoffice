/**
 * B3.2 / Machine-to-machine access-decision route.
 *
 * `POST /api/v1/access-decisions` is the single BackOffice endpoint
 * the broader quorum ecosystem calls (portal-api / Canvas pipeline,
 * jitsi-join coordinator, …) to obtain an allow/deny decision for a
 * student trying to join a Jitsi room from a specific device with a
 * pre-issued OTP.
 *
 * HTTP semantics:
 *
 *   - Transport auth (HMAC-SHA256) is enforced by a `requireServiceAuth`
 *     preHandler built from `BACKOFFICE_SERVICE_TOKENS` +
 *     `BACKOFFICE_SERVICE_HMAC_SKEW_SECONDS`. Every failure mode
 *     (missing header, unknown name, bad signature, stale ts, empty
 *     registry) collapses to `deny.idp_untrusted` 401 so the wire
 *     envelope never leaks the specific reason.
 *   - Every AUTHENTICATED outcome — allow OR deny — returns HTTP 200
 *     with the `DecisionResponse` envelope. The decision policy lives
 *     in `AccessDecisionService.decide()`; this route is the thin
 *     HTTP shell that wires Zod validation, the service, and the
 *     shared error envelope together.
 *   - Invalid bodies (missing `canvas_user_id`, wrong types, …) emit
 *     `validation_error` 400 via the centralized `httpErrorHandler`.
 *
 * Audit wiring is intentionally deferred to a later unit: the OTP
 * consumption in the underlying `OtpClient.verify` is the
 * attestation, and this unit ships the smallest end-to-end contract
 * first.
 */
import type { FastifyInstance } from 'fastify';
import {
  DecisionRequest,
  DecisionResponse,
} from '@quorum-backoffice/shared';
import {
  captureRawBodyPlugin,
  parseServiceTokens,
  requireServiceAuth,
} from '../plugins/service-auth';
import { AccessDecisionService } from '../services/access-decision-service';
import { PgDispositivoRepo } from '../repositories/pg-dispositivos';

export async function registerAccessDecisionsRoutes(app: FastifyInstance): Promise<void> {
  // The raw-body capture plugin MUST be registered before the route
  // handler runs so `req.rawBody` is populated before the HMAC
  // preHandler consults it. fastify-plugin scopes the registration
  // to the encapsulation context, so calling it here attaches the
  // content-type parser globally inside this plugin (the same shape
  // `app.ts` uses for the rest of the service surface).
  await app.register(captureRawBodyPlugin);

  // Build the service-auth preHandler once, from the app config. The
  // plugin fails closed when the parsed registry is empty, so a
  // misconfigured deploy that sets BACKOFFICE_SERVICE_TOKENS='' can
  // never silently allow traffic.
  const registry = parseServiceTokens({
    BACKOFFICE_SERVICE_TOKENS: app.config.BACKOFFICE_SERVICE_TOKENS,
  });
  const skewSeconds = app.config.BACKOFFICE_SERVICE_HMAC_SKEW_SECONDS;
  const preHandler = requireServiceAuth({ registry, skewSeconds });

  // Build the service once per app instance. The service holds only
  // a reference to the OtpClient-equivalent HTTP boundary (via
  // `app.otpClient`, set by `auth-deps.ts`) and the fail-closed
  // owner-check repository; both are resolved lazily inside the
  // handler so per-request overrides (e.g. test fakes) still apply.
  const getService = (): AccessDecisionService =>
    new AccessDecisionService({
      otp: app.otpClient,
      checkOwner: async (serialNumber: string, canvasUserId: number) => {
        const repo = new PgDispositivoRepo(app.pg as unknown as import('pg').Pool);
        return repo.findActiveOwnerBySerialAndCanvasId(serialNumber, canvasUserId);
      },
    });

  app.post(
    '/api/v1/access-decisions',
    { preHandler },
    async (req, reply): Promise<DecisionResponse> => {
      // Zod validation goes through the centralized error handler
      // so invalid bodies emit `{ code: 'validation_error', ... }`
      // at HTTP 400 — same envelope the rest of the API uses.
      const body = DecisionRequest.parse(req.body);

      const svc = getService();
      const decision = await svc.decide(body, {
        ip: req.ip ?? null,
        userAgent:
          typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
      });

      // Every authenticated outcome — allow OR deny — is 200.
      // Transport auth failures are 401 (emitted by the preHandler
      // before the handler runs) and body validation failures are
      // 400 (emitted by httpErrorHandler on the Zod throw). The
      // decision policy itself never throws AppError back to the
      // handler: dependency failures are mapped to deny.dependency_fail.
      reply.status(200);
      return decision;
    },
  );
}