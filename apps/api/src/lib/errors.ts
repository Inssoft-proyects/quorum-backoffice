/**
 * Centralized error types and Fastify error handler.
 *
 * AppError carries a stable machine-readable code and an HTTP status; route
 * handlers throw AppError instances and the global handler maps them to the
 * response envelope. Unknown errors become 500 Internal Server Error.
 */
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodError } from 'zod';

export class AppError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details?: unknown;

  constructor(code: string, message: string, httpStatus: number, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError('bad_request', message, 400, details);
  }
  static unauthorized(message = 'unauthorized', details?: unknown): AppError {
    return new AppError('unauthorized', message, 401, details);
  }
  static forbidden(message = 'forbidden', details?: unknown): AppError {
    return new AppError('forbidden', message, 403, details);
  }
  static notFound(message = 'not found', details?: unknown): AppError {
    return new AppError('not_found', message, 404, details);
  }
  static conflict(message: string, details?: unknown): AppError {
    return new AppError('conflict', message, 409, details);
  }
  static unprocessable(message: string, details?: unknown): AppError {
    return new AppError('unprocessable_entity', message, 422, details);
  }
  static internal(message = 'internal error', details?: unknown): AppError {
    return new AppError('internal', message, 500, details);
  }
  static serviceUnavailable(message: string, details?: unknown): AppError {
    return new AppError('service_unavailable', message, 503, details);
  }
}

export interface ErrorEnvelope {
  code: string;
  message: string;
  details?: unknown;
  traceId?: string;
}

/**
 * Global Fastify error handler.
 *
 * IMPORTANT: this handler must NOT return the envelope. Fastify's
 * `error-handler.js` (see node_modules/fastify/lib/error-handler.js)
 * does `reply.send(result)` on whatever the handler returns. If we
 * both call `reply.send(envelope)` AND return the envelope, Fastify
 * tries to send twice. The second call is a no-op for the wire (the
 * response is already on the socket) but logs
 * `FST_ERR_REP_ALREADY_SENT: "Reply was already sent, did you
 * forget to \"return reply\" in \"/api/v1/marbetes/bulk-xlsx\"
 * (POST)?"` — which the operator sees as two errors for one
 * request. Returning `void` breaks the chain and silences the
 * warning.
 */
export function httpErrorHandler(
  err: FastifyError | AppError | ZodError | Error,
  req: FastifyRequest,
  reply: FastifyReply,
): void {
  const traceId = req.id;

  if (err instanceof AppError) {
    req.log.warn({ err: { code: err.code, message: err.message }, traceId }, 'app_error');
    const envelope: ErrorEnvelope = { code: err.code, message: err.message, traceId };
    if (err.details !== undefined) envelope.details = err.details;
    reply.status(err.httpStatus).send(envelope);
    return;
  }

  // Zod validation failures
  if ('issues' in (err as ZodError) && Array.isArray((err as ZodError).issues)) {
    const zodErr = err as ZodError;
    const envelope: ErrorEnvelope = {
      code: 'validation_error',
      message: 'request payload failed validation',
      details: zodErr.issues.map((i) => ({ path: i.path, message: i.message })),
      traceId,
    };
    req.log.warn({ traceId }, 'validation_error');
    reply.status(400).send(envelope);
    return;
  }

  // Fastify validation errors
  if ('validation' in (err as FastifyError) && (err as FastifyError).validation) {
    const fe = err as FastifyError;
    const envelope: ErrorEnvelope = {
      code: 'validation_error',
      message: fe.message,
      details: fe.validation,
      traceId,
    };
    reply.status(fe.statusCode ?? 400).send(envelope);
    return;
  }

  // Unknown
  req.log.error({ err, traceId }, 'unhandled_error');
  const envelope: ErrorEnvelope = {
    code: 'internal',
    message: 'internal server error',
    traceId,
  };
  reply.status(500).send(envelope);
}
