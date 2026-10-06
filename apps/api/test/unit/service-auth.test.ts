/**
 * B3.1 unit tests — `requireServiceAuth()` preHandler + raw-body
 * capture plugin (`apps/api/src/plugins/service-auth.ts`).
 *
 * The preHandler authenticates the inbound caller using the
 * HMAC-SHA256 scheme shared with quorum-otp. Every failure mode
 * is collapsed into a single `deny.idp_untrusted` 401 response
 * because that's the contract: from the caller's perspective, an
 * invalid HMAC, a stale timestamp, an unknown service name and a
 * missing header all map to "we do not trust this identity".
 *
 * On success the preHandler decorates the request with the caller
 * name (`req.serviceCaller`) so route handlers can attribute
 * downstream side effects (audit, lockout state) to the calling
 * service.
 *
 * Coverage:
 *   - rejection matrix: missing / malformed header, unknown name,
 *     stale ts, bad signature, expired ts, non-numeric ts
 *   - acceptance: valid signature passes and decorates the request
 *   - empty registry: fails closed (rejects every call)
 *   - raw-body capture: the plugin stashes the exact request body
 *     bytes on `req.rawBody` before JSON parse so the HMAC sees
 *     the same bytes the sender signed
 */
import Fastify, { type FastifyInstance } from 'fastify';
import {
  captureRawBodyPlugin,
  requireServiceAuth,
  parseServiceTokens,
} from '../../src/plugins/service-auth';
import { hmacSign } from '../../src/lib/service-hmac';
import { AppError, httpErrorHandler } from '../../src/lib/errors';

const REGISTRY_RAW = 'canvas-portal:shared-secret-canvas-001,jitsi-join:shared-secret-jitsi-002';
const REGISTRY = parseServiceTokens({ BACKOFFICE_SERVICE_TOKENS: REGISTRY_RAW } as never);
const SKEW = 60;
const SVC_NAME = 'canvas-portal';
const SVC_SECRET = 'shared-secret-canvas-001';
const OTHER_NAME = 'jitsi-join';
const OTHER_SECRET = 'shared-secret-jitsi-002';

/** Build a tiny Fastify that wires the raw-body capture + the preHandler. */
async function buildTestApp(opts: {
  registry: Map<string, string>;
  skew?: number;
  routePath?: string;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Install the production error handler so AppError instances
  // thrown by the preHandler are translated into the documented
  // {code,message,traceId} envelope with the right HTTP status.
  // Without this, Fastify defaults to a 500 for any thrown error.
  app.setErrorHandler(httpErrorHandler);
  await app.register(captureRawBodyPlugin);
  app.post(
    opts.routePath ?? '/probe',
    { preHandler: requireServiceAuth({ registry: opts.registry, skewSeconds: opts.skew ?? SKEW }) },
    async (req) => {
      return {
        ok: true,
        caller: (req as unknown as { serviceCaller?: string }).serviceCaller ?? null,
        rawBody: (req as unknown as { rawBody?: string }).rawBody ?? null,
        parsed: req.body,
      };
    },
  );
  return app;
}

describe('requireServiceAuth — acceptance (happy path)', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildTestApp({ registry: REGISTRY });
  });
  afterAll(async () => {
    await app.close();
  });

  it('accepts a request with a valid HMAC signature and decorates the caller name', async () => {
    const body = JSON.stringify({ device_id: 'dev-1', otp_proof: 'AB12CD' });
    const ts = Math.floor(Date.now() / 1000);
    const sig = hmacSign(SVC_SECRET, ts, body);
    const res = await app.inject({
      method: 'POST',
      url: '/probe',
      headers: {
        'content-type': 'application/json',
        authorization: `HMAC ${SVC_NAME} ${ts} ${sig}`,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { ok: boolean; caller: string | null; rawBody: string };
    expect(json.ok).toBe(true);
    expect(json.caller).toBe(SVC_NAME);
    // The plugin MUST stash the exact raw body bytes — the verifier
    // signs/verifies over the same string the JSON parser sees.
    expect(json.rawBody).toBe(body);
  });

  it('accepts a GET (empty body) request when the signature covers `${ts}.`', async () => {
    // Register a GET on a fresh app so we can hit the no-body path.
    const app2 = Fastify({ logger: false });
    app2.setErrorHandler(httpErrorHandler);
    await app2.register(captureRawBodyPlugin);
    app2.get(
      '/probe',
      { preHandler: requireServiceAuth({ registry: REGISTRY, skewSeconds: SKEW }) },
      async (req) => ({
        ok: true,
        caller: (req as unknown as { serviceCaller?: string }).serviceCaller ?? null,
        // Mirror the preHandler's empty-body fallback: GET has no
        // body so the content-type parser never runs and rawBody
        // is undefined. The preHandler signs over the empty string
        // in that case, so we report `''` here too.
        rawBody: (req as unknown as { rawBody?: string }).rawBody ?? '',
      }),
    );
    try {
      const ts = Math.floor(Date.now() / 1000);
      const sig = hmacSign(OTHER_SECRET, ts, '');
      const res = await app2.inject({
        method: 'GET',
        url: '/probe',
        headers: { authorization: `HMAC ${OTHER_NAME} ${ts} ${sig}` },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json() as { ok: boolean; caller: string | null; rawBody: string };
      expect(json.ok).toBe(true);
      expect(json.caller).toBe(OTHER_NAME);
      expect(json.rawBody).toBe('');
    } finally {
      await app2.close();
    }
  });
});

describe('requireServiceAuth — rejection matrix (all collapse to deny.idp_untrusted 401)', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildTestApp({ registry: REGISTRY });
  });
  afterAll(async () => {
    await app.close();
  });

  /** Convenience: post a JSON body signed by a given secret at `ts`. */
  async function postSigned(args: {
    body?: string;
    ts?: number;
    secret?: string;
    serviceName?: string;
    authorizationOverride?: string;
  }) {
    const body = args.body ?? JSON.stringify({ device_id: 'dev-1', otp_proof: 'AB12CD' });
    const ts = args.ts ?? Math.floor(Date.now() / 1000);
    const sig = hmacSign(args.secret ?? SVC_SECRET, ts, body);
    const authorization =
      args.authorizationOverride ??
      `HMAC ${args.serviceName ?? SVC_NAME} ${ts} ${sig}`;
    return app.inject({
      method: 'POST',
      url: '/probe',
      headers: {
        'content-type': 'application/json',
        authorization,
      },
      payload: body,
    });
  }

  it('rejects a missing Authorization header with 401 deny.idp_untrusted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/probe',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ device_id: 'dev-1', otp_proof: 'AB12CD' }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'deny.idp_untrusted' });
  });

  it('rejects a header that does not start with `HMAC ` (e.g. Bearer)', async () => {
    const res = await postSigned({
      authorizationOverride: `Bearer ${SVC_NAME} ${Math.floor(Date.now() / 1000)} deadbeef`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'deny.idp_untrusted' });
  });

  it('rejects a header with the wrong number of parts (e.g. only 2 tokens)', async () => {
    const res = await postSigned({
      authorizationOverride: `HMAC ${SVC_NAME} ${Math.floor(Date.now() / 1000)}`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'deny.idp_untrusted' });
  });

  it('rejects a non-numeric timestamp', async () => {
    const res = await postSigned({
      authorizationOverride: `HMAC ${SVC_NAME} notanumber ${'a'.repeat(64)}`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'deny.idp_untrusted' });
  });

  it('rejects an unknown service name (not in the registry)', async () => {
    const res = await postSigned({ serviceName: 'unknown-svc' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'deny.idp_untrusted' });
  });

  it('rejects a stale timestamp beyond the skew window', async () => {
    const res = await postSigned({ ts: Math.floor(Date.now() / 1000) - (SKEW + 5) });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'deny.idp_untrusted' });
  });

  it('rejects a future timestamp beyond the skew window', async () => {
    const res = await postSigned({ ts: Math.floor(Date.now() / 1000) + (SKEW + 5) });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'deny.idp_untrusted' });
  });

  it('rejects a tampered body (signature no longer matches the bytes the server sees)', async () => {
    // Sign a body, then send a DIFFERENT body with the same sig.
    const signedBody = JSON.stringify({ device_id: 'dev-1', otp_proof: 'AB12CD' });
    const ts = Math.floor(Date.now() / 1000);
    const sig = hmacSign(SVC_SECRET, ts, signedBody);
    const tamperedBody = JSON.stringify({ device_id: 'dev-1', otp_proof: 'ZZ99XX' });
    const res = await app.inject({
      method: 'POST',
      url: '/probe',
      headers: {
        'content-type': 'application/json',
        authorization: `HMAC ${SVC_NAME} ${ts} ${sig}`,
      },
      payload: tamperedBody,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'deny.idp_untrusted' });
  });

  it('rejects a signature computed with the wrong secret', async () => {
    const res = await postSigned({ secret: 'a-completely-different-secret-32-bytes!' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'deny.idp_untrusted' });
  });

  it('rejects a malformed signature (wrong length)', async () => {
    const res = await postSigned({
      authorizationOverride: `HMAC ${SVC_NAME} ${Math.floor(Date.now() / 1000)} abc`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'deny.idp_untrusted' });
  });
});

describe('requireServiceAuth — empty registry (fail-closed)', () => {
  it('rejects every call when the configured registry is empty', async () => {
    const app = await buildTestApp({ registry: new Map(), skew: SKEW });
    try {
      // Even a perfectly valid signature for some hypothetical
      // service must be rejected: an empty registry means "we
      // trust no one".
      const ts = Math.floor(Date.now() / 1000);
      const sig = hmacSign('whatever-secret', ts, '{}');
      const res = await app.inject({
        method: 'POST',
        url: '/probe',
        headers: {
          'content-type': 'application/json',
          authorization: `HMAC whoever ${ts} ${sig}`,
        },
        payload: '{}',
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: 'deny.idp_untrusted' });
    } finally {
      await app.close();
    }
  });
});

describe('parseServiceTokens — env format `name:secret,name:secret`', () => {
  it('parses a single entry', () => {
    const r = parseServiceTokens({
      BACKOFFICE_SERVICE_TOKENS: 'svc-a:secret-a',
    } as never);
    expect(r.get('svc-a')).toBe('secret-a');
  });

  it('parses a comma-separated list and ignores empty segments', () => {
    const r = parseServiceTokens({
      BACKOFFICE_SERVICE_TOKENS: 'svc-a:secret-a,,svc-b:secret-b,',
    } as never);
    expect(r.get('svc-a')).toBe('secret-a');
    expect(r.get('svc-b')).toBe('secret-b');
    expect(r.size).toBe(2);
  });

  it('tolerates a secret that contains a colon (only the FIRST `:` splits)', () => {
    const r = parseServiceTokens({
      BACKOFFICE_SERVICE_TOKENS: 'svc-a:secret:with:colons',
    } as never);
    expect(r.get('svc-a')).toBe('secret:with:colons');
  });

  it('skips entries without a colon (malformed)', () => {
    const r = parseServiceTokens({
      BACKOFFICE_SERVICE_TOKENS: 'svc-a-malformed,svc-b:secret-b',
    } as never);
    expect(r.has('svc-a-malformed')).toBe(false);
    expect(r.get('svc-b')).toBe('secret-b');
  });

  it('returns an empty map for an empty string (caller decides fail-closed semantics)', () => {
    const r = parseServiceTokens({ BACKOFFICE_SERVICE_TOKENS: '' } as never);
    expect(r.size).toBe(0);
  });
});

describe('AppError shape — sanity check that the preHandler emits the contract envelope', () => {
  it('AppError(code, message, httpStatus) exposes the deny.idp_untrusted code on 401', () => {
    // Belt-and-suspenders against accidental constructor drift.
    const e = new AppError('deny.idp_untrusted', 'untrusted caller', 401);
    expect(e.code).toBe('deny.idp_untrusted');
    expect(e.httpStatus).toBe(401);
  });
});
