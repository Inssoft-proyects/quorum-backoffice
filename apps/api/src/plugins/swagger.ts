/**
 * Fastify plugin: OpenAPI 3.1 document + Swagger UI.
 *
 * Registers:
 *   - `@fastify/swagger` with a stable, host-relative server entry
 *     so the document can be served from any vhost without
 *     re-generation.
 *   - `@fastify/swagger-ui` at the stable path `/docs` so the
 *     existing `backend.quorum.asistentepro.mx/mfa/` static
 *     deployment can be retired in favor of the live UI.
 *   - A small set of shared envelope components (ErrorEnvelope,
 *     DenyEnvelope) that the MFA routes inline in their response
 *     shapes. The MFA request/response DTOs live in
 *     `packages/shared/src/dto/mfa.ts` and are attached directly
 *     to the route definitions so the JSON Schemas are derived
 *     from the Zod source of truth (no hand-duplicated shapes).
 *
 * Why fastify-type-provider-zod and not zod-to-json-schema
 * directly:
 *
 *   - It's the Fastify-blessed bridge. The same package gives us
 *     `jsonSchemaTransform` (used by `@fastify/swagger` to walk
 *     the route `schema` and replace Zod instances with their
 *     JSON Schema equivalents), `createJsonSchemaTransformObject`
 *     (used to extract the inlined envelope Zod schemas into
 *     `components.schemas` and rewrite the route responses to
 *     `$ref` them), AND the optional `validatorCompiler` /
 *     `serializerCompiler` should the maintainers want to move
 *     validation off the imperative `ZodSchema.parse()` in the
 *     route handlers in a future work unit. Today we keep the
 *     imperative parse (it owns the documented `validation_error`
 *     400 envelope via the centralized error handler) and use
 *     only the transform / transformObject halves of the package.
 *
 * What this plugin deliberately does NOT do:
 *
 *   - Set fastify-type-provider-zod's `validatorCompiler` /
 *     `serializerCompiler`. The route handlers keep their
 *     existing `ZodSchema.parse()` calls so the wire-level
 *     `validation_error` envelope is unchanged. We install a
 *     no-op pair instead so the Zod instances placed in each
 *     route's `schema` (purely for swagger doc generation) are
 *     ignored by Fastify's request pipeline. See the
 *     "no-op compilers" comment below for the rationale.
 */
import fp from 'fastify-plugin';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import {
  createJsonSchemaTransformObject,
  jsonSchemaTransform,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Envelope Zod schemas (component-level, not bound to a request body)
// ---------------------------------------------------------------------------
//
// These mirror the wire shape emitted by `apps/api/src/lib/errors.ts`:
//   - `ErrorEnvelope` is the centralized handler's shape for every
//     Zod / Fastify validation failure (code = 'validation_error').
//   - `DenyEnvelope` is the shape for every AppError deny (the
//     `code` enum is the union of every deny code the BackOffice
//     MFA surface can emit — MFA authentication + MFA redirect-token
//     consume + service-auth transport failures).
//
// Defining them as Zod here (instead of as raw JSON Schema) keeps
// the schema registry consistent: every entry under
// `components.schemas` is derived from a Zod source via
// `createJsonSchemaTransformObject`.
//
// `details` is `optional` (not `nullable`); the JSON Schema is
// `{}` (any value, may be missing). Using `nullable: true` here
// would make the property render as `details: { nullable: true }`
// in the component registry, but `@fastify/swagger` would strip
// the modifier when post-processing the inlined route response
// for OpenAPI 3.1 (the `convertNullableToNullType` pass deletes
// `nullable` when the property has no `type`), so the inlined
// route schema would not match the component schema and
// `createJsonSchemaTransformObject` would fail to extract the
// envelope into `components.schemas`. The hand-authored
// `mfa.openapi.yaml` declares the same property as `{ nullable: true }`,
// so this is an intended difference between the generated spec
// and the hand-authored one (the JSON Schema is semantically
// equivalent — both accept any value or none).
export const ErrorEnvelope = z.object({
  code: z.literal('validation_error'),
  message: z.string(),
  details: z.unknown().optional(),
  traceId: z.string().optional(),
});
export const DenyEnvelope = z.object({
  code: z.enum([
    'deny.marbete_unknown',
    'deny.student_inactive',
    'deny.device_unknown',
    'deny.device_not_bound_to_student',
    'deny.otp_missing',
    'deny.otp_invalid',
    'deny.dependency_fail',
    'mfa_token_invalid',
    'mfa_redirect_origin_not_allowed',
    'mfa_session_kind_invalid',
    'unauthorized',
  ]),
  message: z.string(),
  details: z.unknown().optional(),
  traceId: z.string().optional(),
});

// ---------------------------------------------------------------------------
// No-op validator/serializer compilers
// ---------------------------------------------------------------------------
//
// The MFA route handlers keep their imperative `ZodSchema.parse()`
// calls (the centralized error handler in `apps/api/src/lib/errors.ts`
// maps the resulting `ZodError` to the documented `validation_error`
// 400 envelope — see the "Zod validation failures" branch).
//
// We deliberately do NOT install
// `fastify-type-provider-zod`'s `validatorCompiler` here because that
// compiler throws a `FastifyError` with the Zod issues folded into
// `err.validation`, which the centralized error handler maps to the
// *FastifyError* branch — same `code: 'validation_error'`, same 400,
// but a different `message` (Fastify's `body/<field> must …`) and
// `details` shape (Ajv-ish vs. Zod). Preserving the existing
// ZodError path keeps the wire envelope byte-for-byte identical
// to today's.
//
// The route `schema` properties (with their Zod instances) are
// therefore ignored by Fastify's request pipeline. The
// `jsonSchemaTransform` passed to `@fastify/swagger` is the ONLY
// consumer of those schemas today: it walks each route's `schema`
// at document-build time and replaces Zod instances with their
// JSON Schema equivalents so the OpenAPI 3 document is fully
// populated. See `apps/api/src/routes/mfa.ts` and
// `apps/api/src/routes/mfa-tokens.ts` for the route-level wiring.
//
// The compiler functions are typed as `unknown` so we don't have
// to thread Fastify's generic `FastifySchemaCompiler<T>` shape
// through the call site; `setValidatorCompiler` accepts the
// permissive shape via a `as never` cast (Fastify v5's overloads
// are strict about the type provider generic).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const noopValidator: any = () => async () => true;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const noopSerializer: any = () => (data: unknown) =>
  JSON.stringify(data);

async function plugin(app: FastifyInstance): Promise<void> {
  // No-op validation / serialization so Zod schemas in the route
  // `schema` options are ignored by the request pipeline (the route
  // handlers do their own `ZodSchema.parse()` for the documented
  // `validation_error` envelope). Cast through `never` because
  // Fastify v5's `setValidatorCompiler` overload is generic over
  // the type provider, and the no-op is provider-agnostic.
  app.setValidatorCompiler(noopValidator as never);
  app.setSerializerCompiler(noopSerializer as never);

  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Quorum BackOffice API',
        version: '0.1.0',
        description:
          'BackOffice admin API. This iteration ships the MFA surface ' +
          '(M1 authenticate / session, M3 redirect-token + consume); ' +
          'other slices opt-in as they attach JSON Schemas to their ' +
          'route definitions.',
      },
      // Host-relative so the same document can be served from any
      // vhost (`backend.*`, `backoffice.*`, `localhost:3100`) without
      // re-generation. The Swagger UI's "Try it out" resolves
      // relative to the page URL.
      servers: [{ url: '/', description: 'Host-relative (resolves to the serving vhost)' }],
      tags: [
        { name: 'mfa', description: 'Autenticación multifactor de estudiantes (M1/M5)' },
        { name: 'redirect', description: 'Redirección SSO Canvas (M3)' },
      ],
    },
    // The transform walks each route's `schema` and replaces Zod
    // instances with their JSON Schema equivalent. Routes that
    // inline the `ErrorEnvelope` / `DenyEnvelope` Zod schemas (in
    // their `response` shape) are emitted with the envelope shape
    // inlined per route. The `transformObject` below then extracts
    // the shared envelopes into `components.schemas` and rewrites
    // the route responses to `$ref` them, mirroring the structure
    // of the hand-authored `mfa.openapi.yaml`.
    transform: jsonSchemaTransform,
    // Same idea at the document level: walk the generated OpenAPI
    // object, find the envelope shapes inlined by the route
    // transform, and replace them with `$ref: '#/components/schemas/...'`
    // so the final document is structurally identical to the
    // hand-authored YAML (single source of truth under
    // `components.schemas`).
    transformObject: createJsonSchemaTransformObject({
      schemas: { ErrorEnvelope, DenyEnvelope },
    }),
    // Hide routes that don't declare a schema so the document stays
    // focused on the curated MFA surface until other slices opt-in.
    hideUntagged: false,
  });

  // The UI is only registered outside of tests because
  // `@fastify/swagger-ui` depends transitively on the
  // ESM-only `content-disposition@3` package, which Jest
  // with the project's `ts-jest` config can't `require()` (it
  // lives under `node_modules` and the default
  // `transformIgnorePatterns` excludes it). Skipping in tests
  // keeps the existing `smoke.test.ts` (and any other test
  // that builds a real app) working; production deploys get
  // the UI.
  //
  // `@fastify/swagger` in dynamic mode only decorates
  // `app.swagger()`; the `/docs/json` and `/docs/yaml` HTTP
  // endpoints are served by `@fastify/swagger-ui`, so they
  // are also absent under `NODE_ENV=test`. The
  // `apps/api/test/unit/swagger.test.ts` suite asserts the
  // document via the `app.swagger()` decorator; the
  // `openapi:dump` script is the canonical way to verify the
  // document for drift review (it builds the app in test mode
  // and writes the document to
  // `apps/api/docs/openapi/mfa.openapi.generated.yaml`).
  if (app.config.NODE_ENV !== 'test') {
    await app.register(fastifySwaggerUi, {
      routePrefix: '/docs',
      // The UI fetches `openapi.json` from the same origin, so a
      // host-relative `servers: [{ url: '/' }]` entry makes "Try it
      // out" work against whichever vhost is serving the doc.
      uiConfig: {
        docExpansion: 'list',
        deepLinking: true,
      },
      staticCSP: true,
    });
  }
}

export default fp(plugin, { name: 'swagger' });
