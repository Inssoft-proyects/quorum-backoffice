/**
 * Unit tests for the @fastify/swagger plugin
 * (apps/api/src/plugins/swagger.ts).
 *
 * Locks down the generated OpenAPI document so the MFA surface can
 * be diffed against the hand-authored `apps/api/docs/openapi/mfa.openapi.yaml`
 * by the `openapi:dump` script. The goal is drift-prevention, NOT
 * a full document check — the schema bodies are derived from the
 * Zod DTOs in `packages/shared/src/dto/mfa.ts` and are exercised
 * there (and via the route-level integration tests).
 *
 * What we assert:
 *   - The four MFA paths are present (`/api/v1/mfa/authenticate`,
 *     `/api/v1/mfa/session`, `/api/v1/mfa/redirect-token`,
 *     `/api/v1/mfa/consume`) with the documented methods.
 *   - The shared envelope components (ErrorEnvelope, DenyEnvelope)
 *     are registered in `components.schemas` so the doc can be
 *     `$ref`'d by the route definitions.
 *   - The generated document is also fetchable via the `app.swagger()`
 *     decorator (a getter on the Fastify instance, not an HTTP
 *     route) so the `openapi:dump` script can serialize it to
 *     YAML for the diff review.
 *
 * Test-environment note on the UI plugin:
 *   `@fastify/swagger-ui` is NOT registered when
 *   `app.config.NODE_ENV === 'test'` (see the plugin's NODE_ENV
 *   branch) because it depends transitively on the ESM-only
 *   `content-disposition@3` package, which Jest with the
 *   project's `ts-jest` config can't `require()`. The UI is
 *   therefore absent in tests; the `openapi:dump` script is
 *   the canonical way to verify the document for drift review
 *   (it builds the app in test mode and writes the document
 *   to `apps/api/docs/openapi/mfa.openapi.generated.yaml`).
 */
import { buildApp } from '../../src/app';

const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  API_PORT: '3099',
  API_HOST: '127.0.0.1',
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:65535/test',
  REDIS_URL: 'redis://127.0.0.1:65535',
  OTP_SERVICE_URL: 'http://127.0.0.1:65535',
  OTP_SERVICE_TOKEN: 'test-otp-token-1234567890',
  CANVAS_PORTAL_API_URL: 'http://127.0.0.1:65535',
  CANVAS_PORTAL_API_TOKEN: 'test-canvas-token-1234567890',
  SESSION_SECRET: 'a'.repeat(64),
  SESSION_TTL_SECONDS: '3600',
};

describe('OpenAPI document (MFA surface)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp({ config: TEST_ENV });
    // Force the swagger document to be built (lazy by default).
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('decorates the Fastify instance with a generated OpenAPI document', () => {
    // The @fastify/swagger plugin attaches `app.swagger()` returning
    // the OpenAPI 3 document. Without the plugin this is undefined.
    expect(typeof (app as unknown as { swagger?: () => unknown }).swagger).toBe(
      'function',
    );
    const doc = (app as unknown as { swagger: () => Record<string, unknown> }).swagger();
    expect(doc).toBeDefined();
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.info).toBeDefined();
  });

  it('contains the four MFA paths with the documented methods', () => {
    const doc = (app as unknown as { swagger: () => { paths: Record<string, Record<string, unknown>> } }).swagger();
    const paths = doc.paths;

    expect(paths['/api/v1/mfa/authenticate']).toBeDefined();
    expect(paths['/api/v1/mfa/authenticate']?.post).toBeDefined();

    expect(paths['/api/v1/mfa/session']).toBeDefined();
    expect(paths['/api/v1/mfa/session']?.get).toBeDefined();

    expect(paths['/api/v1/mfa/redirect-token']).toBeDefined();
    expect(paths['/api/v1/mfa/redirect-token']?.post).toBeDefined();

    expect(paths['/api/v1/mfa/consume']).toBeDefined();
    expect(paths['/api/v1/mfa/consume']?.post).toBeDefined();
  });

  it('registers the documented MFA error envelopes as components', () => {
    const doc = (app as unknown as {
      swagger: () => { components?: { schemas?: Record<string, unknown> } };
    }).swagger();
    const schemas = doc.components?.schemas ?? {};

    // Both envelopes are extracted from the route response shapes
    // by the `createJsonSchemaTransformObject` pass into
    // `components.schemas`, matching the structure of the
    // hand-authored `mfa.openapi.yaml`.
    expect(schemas['ErrorEnvelope']).toBeDefined();
    expect(schemas['DenyEnvelope']).toBeDefined();
  });

  it('returns the same document from app.swagger() on repeat calls', () => {
    // The decorator caches the document (per @fastify/swagger's
    // `cache` object). Repeated calls must return the same
    // reference so callers (the `openapi:dump` script, a future
    // /docs/json route) can rely on a stable shape.
    const doc1 = (app as unknown as { swagger: () => Record<string, unknown> }).swagger();
    const doc2 = (app as unknown as { swagger: () => Record<string, unknown> }).swagger();
    expect(doc1).toBe(doc2);
  });
});
