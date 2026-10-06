# MFA OpenAPI — entrega de contratos al equipo móvil

## Dónde se despliega

`https://backend.quorum.asistentepro.mx/mfa/`

- `index.html` → Swagger UI (carga `openapi.yaml` de la misma ruta).
- `openapi.yaml` → spec OpenAPI 3.1 de la superficie MFA (`authenticate`, `session`,
  `redirect-token`, `consume`) + taxonomía `deny.*`.

`backend.quorum.asistentepro.mx` es un CNAME que ya apunta al host; el vhost
(`infra/nginx/backend.quorum.asistentepro.mx.conf`) reutiliza el certificado
wildcard `*.quorum.asistentepro.mx`, por lo que **no se requiere un cert nuevo**.

## Deploy (borrador, requiere autorización explícita)

1. `cp -r apps/api/docs/openapi /opt/quorum-backoffice/docs/mfa` (o el root de nginx).
2. Instalar `infra/nginx/backend.quorum.asistentepro.mx.conf` en la conf de nginx.
3. `nginx -t && systemctl reload nginx`.

## Pendientes (issues)

- Migrar a `@fastify/swagger` + `@fastify/swagger-ui` para generar el spec desde JSON
  Schemas de las rutas (elimina la deriva manual).
- Decidir si `backend.*` proxy `/api/` para ser el host canónico del API.
