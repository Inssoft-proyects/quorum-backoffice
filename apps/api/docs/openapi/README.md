# OpenAPI — Swagger y specs de la superficie BackOffice

Documento canónico para encontrar los Swagger UI y los specs OpenAPI de la
suite BackOffice: dónde viven en el repo, qué archivos son la fuente de
verdad, y qué URLs públicas los sirven.

## Índice de swaggers / OpenAPI

| Servicio | Swagger UI (sitio) | Spec OpenAPI (sitio) | Fuente en repo (`apps/api/docs/openapi/`) | Desplegado en `/opt` |
|---|---|---|---|---|
| **MFA** (incluye `get-subject`) | `https://backoffice.inecuni.com/mfa/` | `https://backoffice.inecuni.com/mfa/openapi.yaml` | `mfa.openapi.yaml` | `/opt/quorum-backoffice/docs/mfa/` |
| **Cursos** | `https://backoffice.inecuni.com/cursos/` | `https://backoffice.inecuni.com/cursos/openapi.yaml` | `cursos.openapi.yaml` | `/opt/quorum-backoffice/docs/cursos/` |

> **Alias legacy:** `backoffice.quorum.asistentepro.mx/*` redirige (301) a
> `backoffice.inecuni.com/*` (rebranding). Ambas formas llegan al mismo contenido.

### `get-subject` en el swagger de MFA

`get-subject` está **agrupado dentro de MFA** (no es un path `/mfa/get-subject`
aparte). En el spec de MFA aparece como:

- Path: `POST /api/v1/mfa/get-subject` → `operationId: mfaGetSubject`.
- `security: - HMAC: []` (apiKey en header `Authorization: HMAC <name> <ts> <hex>`).
- Request: `MfaGetSubjectRequest` (`{ marbete_code, serial_number }`).
- Response 200: `MfaGetSubjectResponse` (`{ canvas_user_id, matricula }`).

## Fuentes en el repo

Todo vive bajo `apps/api/docs/openapi/` (worktree `quorum-backoffice-access`, rama `main`):

| Archivo | Rol |
|---|---|
| `mfa.openapi.yaml` | **Spec a mano** de MFA (autenticación + `get-subject`). Es la fuente de lo que se despliega a `/mfa/openapi.yaml`. |
| `mfa.openapi.generated.yaml` | Spec **autogenerado** desde los DTOs Zod (`npm run openapi:dump`). Para revisión de drift, no se despliega. |
| `cursos.openapi.yaml` | Spec de la superficie Cursos (`/api/v1/cursos`, `/api/v1/cursos/{id}`). |
| `swagger-ui/index.html` | Plantilla de Swagger UI (carga `openapi.yaml` relativo). |
| `README.md` | Este documento. |

## Dónde se despliega (website)

Los specs estáticos se sirven por nginx desde `/opt/quorum-backoffice/docs/`:

- MFA → `/opt/quorum-backoffice/docs/mfa/{index.html,openapi.yaml}`
- Cursos → `/opt/quorum-backoffice/docs/cursos/{index.html,openapi.yaml}`

Mapping nginx (vhost `backend.quorum.asistentepro.mx.conf` y vhost backoffice operator-side):

```
location /mfa/      { root /opt/quorum-backoffice/docs; index index.html; }
location /cursos/   { root /opt/quorum-backoffice/docs; index index.html; }
```

> **Host canónico pendiente:** el vhost `backend.quorum.asistentepro.mx` está
> activo en el host, pero el registro DNS (CNAME → backoffice) **aún no
> resuelve**. Mientras tanto, los mismos docs se sirven en el subdominio
> `backoffice` (hoy rebrandeado a `inecuni.com`).

## Spec generado (`@fastify/swagger` + `@fastify/swagger-ui`)

La app Fastify también expone Swagger generado en runtime
(`apps/api/src/plugins/swagger.ts`, `routePrefix: '/docs'`):

- `GET /docs` → Swagger UI.
- `GET /docs/json` → `openapi.json`.
- `GET /docs/yaml` → `openapi.yaml`.

**Alcance:** solo es alcanzable por **port-forward** (ej. `http://127.0.0.1:4100/docs/`),
porque el nginx público enruta `/api/` pero **no** `/docs/`. Para la entrega al
equipo móvil/terceros se usan los specs estáticos de la tabla de arriba, no `/docs/`.

- La UI se deshabilita en `NODE_ENV=test` (dependencia ESM `content-disposition@3`
  incompatible con `ts-jest`).
- El spec generado se construye desde los DTOs Zod de `packages/shared/src/dto/mfa.ts`
  (no hay shapes duplicados a mano).

## Procedimiento para actualizar un spec estático

1. Editar el YAML fuente en el repo (`mfa.openapi.yaml` o `cursos.openapi.yaml`).
2. Desplegar el archivo a `/opt`:
   ```bash
   sudo cp apps/api/docs/openapi/mfa.openapi.yaml /opt/quorum-backoffice/docs/mfa/openapi.yaml
   sudo chown www-data:www-data /opt/quorum-backoffice/docs/mfa/openapi.yaml
   sudo chmod 644 /opt/quorum-backoffice/docs/mfa/openapi.yaml
   ```
3. Validar:
   ```bash
   curl -s https://backoffice.inecuni.com/mfa/openapi.yaml | grep -c "get-subject"
   ```
   No requiere `nginx reload` (es contenido de un archivo estático ya mapeado).

> **Historial (gap corregido 2026-10-15):** tras el merge del PR #19 el spec
> estático de `/mfa/` quedó en la versión 06-oct (sin `get-subject`) porque el
> deploy solo movió código, no `apps/api/docs/openapi/`. Se corrigió copiando
> `mfa.openapi.yaml` a `/opt/quorum-backoffice/docs/mfa/openapi.yaml` y validando
> contra el sitio. Registro completo en `odd/tasks/mfa-get-subject.md` (L12).

## Pendientes

- Resolver el DNS del host canónico `backend.quorum.asistentepro.mx` (CNAME).
- Decidir si `backend.*` pasa a ser el host canónico del API (`/api/`).
- Retirar el spec a mano una vez que el generado (`mfa.openapi.generated.yaml`)
  se acepte como fuente única (issue separada).
