/**
 * MFA `get-subject` route — `POST /api/v1/mfa/get-subject`.
 *
 * Server-to-server identity resolution: a trusted service sends a
 * marbete code + the device serial bound to the same student and
 * receives the student's `canvas_user_id` (the OTP subject) plus
 * SIS matrícula. This is the lookup a caller needs BEFORE it can
 * issue an OTP (`subject = String(canvas_user_id)`,
 * `scope = mfa.access`).
 *
 * Transport auth is the SAME HMAC-SHA256 service-token plane the
 * MFA consume endpoint (`POST /api/v1/mfa/consume`) and the
 * access-decision endpoint use: a `requireServiceAuth` preHandler
 * built from `BACKOFFICE_SERVICE_TOKENS` +
 * `BACKOFFICE_SERVICE_HMAC_SKEW_SECONDS`. Every transport failure
 * collapses to `deny.idp_untrusted` 401, and an empty registry
 * fails closed.
 *
 * Status codes:
 *
 *   - 200 OK — resolved; body is
 *     `{ canvas_user_id, matricula | null }`.
 *   - 400 Bad Request — body failed Zod validation
 *     (`validation_error`).
 *   - 401 Unauthorized — transport auth failure
 *     (`deny.idp_untrusted`) OR a deny in the MFA taxonomy
 *     (`deny.marbete_unknown`, `deny.student_inactive`,
 *     `deny.device_unknown`, `deny.device_not_bound_to_student`).
 *
 * The raw-body capture plugin (`captureRawBodyPlugin`) is registered
 * globally by `registerAccessDecisionsRoutes` (which runs first in
 * `app.ts`), so `req.rawBody` is populated before this route's HMAC
 * preHandler consults it. Registering it here again would throw
 * ("Content type parser 'application/json' already present") — see
 * the same note in `routes/mfa-tokens.ts`.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { MfaGetSubjectRequest, MfaGetSubjectResponse } from '@quorum-backoffice/shared';
import { AppError } from '../lib/errors';
import { DenyEnvelope, ErrorEnvelope } from '../plugins/swagger';
import { parseServiceTokens, requireServiceAuth } from '../plugins/service-auth';
import { MfaGetSubjectService } from '../services/mfa-get-subject-service';
import { MfaAuthenticateError } from '../services/mfa-authenticate-service';

export async function registerMfaGetSubjectRoutes(app: FastifyInstance): Promise<void> {
  // Build the service-auth preHandler once per app instance from the
  // app config. The plugin fails closed when the parsed registry is
  // empty, so a misconfigured deploy cannot silently allow traffic.
  const registry = parseServiceTokens({
    BACKOFFICE_SERVICE_TOKENS: app.config.BACKOFFICE_SERVICE_TOKENS,
  });
  const skewSeconds = app.config.BACKOFFICE_SERVICE_HMAC_SKEW_SECONDS;
  const preHandler = requireServiceAuth({ registry, skewSeconds });

  // Type alias for the route that attaches Zod schemas for swagger
  // doc generation (`/docs`). The swagger plugin installs no-op
  // validator/serializer compilers, so runtime validation stays the
  // imperative `MfaGetSubjectRequest.parse` call in the handler.
  const zApp = app.withTypeProvider<ZodTypeProvider>();

  const getService = (): MfaGetSubjectService =>
    new MfaGetSubjectService({
      pool: app.pg as unknown as import('pg').Pool,
    });

  zApp.post(
    '/api/v1/mfa/get-subject',
    {
      preHandler,
      schema: {
        body: MfaGetSubjectRequest,
        response: {
          200: MfaGetSubjectResponse,
          400: ErrorEnvelope,
          401: DenyEnvelope,
        },
        tags: ['mfa'],
      },
    },
    async (req, reply): Promise<MfaGetSubjectResponse> => {
      // Zod validation → centralized `validation_error` 400 envelope
      // on failure (same path as the rest of the API).
      const body = MfaGetSubjectRequest.parse(req.body);

      const svc = getService();
      let result;
      try {
        result = await svc.resolve({
          marbeteCode: body.marbete_code,
          serialNumber: body.serial_number,
        });
      } catch (err) {
        if (err instanceof MfaAuthenticateError) {
          // Every MFA deny code is a 401 on this surface: the caller
          // presented a valid service token but the (marbete, serial)
          // pair did not resolve to an active student. Unknown /
          // revoked / mismatched all collapse into the same envelope
          // (no distinction leaks to the caller).
          throw new AppError(err.code, err.message, 401, err.details);
        }
        // Any other thrown error (DB outage, etc.) propagates to the
        // centralized handler, which maps it to a fail-closed
        // dependency envelope.
        throw err;
      }

      reply.status(200);
      return {
        canvas_user_id: result.canvasUserId,
        matricula: result.matricula,
      };
    },
  );
}
