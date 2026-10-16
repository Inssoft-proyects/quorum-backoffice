# MFA OpenAPI — entrega de contratos al equipo móvil

## Dónde se despliega

`https://backend.quorum.asistentepro.mx/mfa/`

- `index.html` → Swagger UI (carga `openapi.yaml` de la misma ruta).
- `openapi.yaml` → spec OpenAPI 3.1 de la superficie MFA (`authenticate`, `session`,
  `redirect-token`, `consume`) + taxonomía `deny.*`.

`backend.quorum.asistentepro.mx` es un CNAME que ya apunta al host; el vhost
(`infra/nginx/backend.quorum.asistentepro.mx.conf`) reutiliza el certificado
wildcard `*.quorum.asistentepro.mx`, por lo que **no se requiere un cert nuevo**.

## Spec generado (issue #9)

A partir de esta iteración la superficie MFA también se sirve desde la app
vía `@fastify/swagger` + `@fastify/swagger-ui` (registrados en
`apps/api/src/plugins/swagger.ts`):

- Documento OpenAPI 3.1 → `GET /docs/json` (servido por `@fastify/swagger`).
- UI interactiva → `GET /docs` (servida por `@fastify/swagger-ui`,
  deshabilitada cuando `NODE_ENV=test` para evitar la dependencia
  ESM `content-disposition@3` que Jest no puede `require()` con la
  config `ts-jest` actual).

El spec se construye desde los JSON Schemas que las rutas derivan de los
DTOs Zod en `packages/shared/src/dto/mfa.ts` — **no hay shapes
hand-duplicados**. El `transformObject` de `fastify-type-provider-zod`
extrae los envelopes compartidos (`ErrorEnvelope`, `DenyEnvelope`) a
`components.schemas` y reescribe las respuestas de las rutas a `$ref`
para que la estructura del documento generado sea estructuralmente
idéntica a la del YAML hand-authored.

### Diff vs. el YAML estático

`npm run openapi:dump --workspace @quorum-backoffice/api` escribe el spec
generado a `apps/api/docs/openapi/mfa.openapi.generated.yaml` para
revisión. Diferencias intencionales (todas documentadas en el
encabezado de `mfa.openapi.generated.yaml`):

1. **`description: "Default Response"`** en cada respuesta (el spec
   hand-authored usa descripciones localizadas; el generado usa la
   default de `@fastify/swagger`).
2. **`details: {}`** en `ErrorEnvelope` / `DenyEnvelope` (el
   hand-authored declara `details: { nullable: true }`; el Zod
   `z.unknown().optional()` se serializa sin el modificador nullable
   porque `@fastify/swagger` lo descartaría en el post-proceso de
   OpenAPI 3.1, rompiendo la equivalencia de `JSON.stringify` que
   usa `createJsonSchemaTransformObject` para extraer los
   componentes).
3. **`otp`** en `MfaAuthenticateRequest` se serializa con `allOf`
   (refleja el `.trim().transform().pipe()` del DTO Zod).
4. **`MfaConsumeResponse.role`** se enumera como `['student']`
   (el YAML hand-authored lista los roles de Canvas;
   el tipo de retorno real del servicio es `'student'`).
5. **Todas las rutas** aparecen en el documento generado, no
   solo las del MFA; las que no tienen `schema` adjunto se
   renderizan con `Default Response` (poco útil hasta que cada
   slice adjunte su Zod schema).

## Deploy (borrador, requiere autorización explícita)

1. `cp -r apps/api/docs/openapi /opt/quorum-backoffice/docs/mfa` (o el root de nginx).
2. Instalar `infra/nginx/backend.quorum.asistentepro.mx.conf` en la conf de nginx.
3. `nginx -t && systemctl reload nginx`.

## Pendientes (issues)

- ~~Migrar a `@fastify/swagger` + `@fastify/swagger-ui` para generar el spec desde JSON
  Schemas de las rutas (elimina la deriva manual).~~ **Cerrado en #9.**
- Decidir si `backend.*` proxy `/api/` para ser el host canónico del API.
- Retirar el spec hand-authored una vez que el generado se acepte
  como la fuente única de verdad (issue separada).
