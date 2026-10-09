# Quorum Backoffice

Administrative backoffice for the Quorum suite. Owns the physical
security surface (security badges / "marbetes", authorized devices)
and the audit trail of every privileged action.

> **Status (2026-09-26)**: MVP COMPLETO + **paridad visual contra la maqueta Inec en las 4 pantallas authed** (merged en master `c85bb41`).
> Las pantallas `/backoffice/{dashboard,marbetes,dispositivos,audit}` están alineadas al canon HTML
> `diseno/maqueta_Inec/Inec/inventario-credenciales.html` con score híbrido 97.11% (pixel ≥93%, structural 100%) medido contra el bundle desplegado en producción.
> Login: usuario `admin` + OTP pre-issued (HMAC contra `quorum-otp`).
> Ver `odd/tasks/backoffice-maquette-parity.md` para el detalle por sub-tarea.

## Tabla de sistemas (Quorum suite)

| Sistema | Workspace / repo | URL pública | Acceso (rol / método) | Descripción |
|---|---|---|---|---|
| **Quorum Backoffice** (este repo) | `/planQuorum/dev/quorum-backoffice/` | `https://backoffice.inecuni.com/login` | Username (`admin` / `auditor` / `operator`) + OTP pre-issued vía HMAC contra `quorum-otp` (ver [§ Acceso seed](#acceso-seed-backoffice)) | Backoffice administrativo. Marbetes QR, dispositivos autorizados, audit log. **Polish WU v4** agregó bulk upload (`POST /api/v1/marbetes/bulk`); **Polish WU v5** rediseñó `/audit` per maqueta InecConecta; **`feature/backoffice-maquette-parity`** (merged `c85bb41`) alineó las 4 pantallas authed a la maqueta Inec con paridad 97.11% hybrid. |
| Quorum Backoffice API | (mismo workspace) | `https://backoffice.inecuni.com/api/v1/...` | Cookie `__Host-sid` (admin / auditor / operator) + header `X-OTP-Code` en operaciones destructivas | API REST Fastify 5 + TS. Health: `GET /healthz`, ready: `GET /readyz`. Login es `POST /api/v1/auth/login` con `{username, otp}` (HMAC contra `quorum-otp`). |
| Quorum Meet (Jitsi) | `/planQuorum/dev/quorum-jitsi/` | `https://quorum.inecuni.com/` | Libre (autoregistro) | Videoconferencia WebRTC. Jicofo + JVB + Prosody XMPP + Jibri recording. |
| Quorum LMS (Canvas) | `/planQuorum/dev/quorum-canvas/` | `https://lms.inecuni.com/` | LTI 1.3 launch desde Jitsi | LMS aislado de portal-api. LMS-side scripts (reconcile roster, one-shot import, force-sync) corren operator-side. |
| Quorum OTP | `/planQuorum/dev/quorum-otp/` | `http://127.0.0.1:8080/ui/` (dev) / `OTP_SERVICE_URL` (prod, ver configMap) | `E2E_OTP_*` env vars en deployment | Servicio OTP para operaciones destructivas. **En staging actual está en `http://placeholder.invalid/v1`** (modo bypass — destructive ops devuelven 401 `otp_required` con el flag `AUTH_OTP_REQUIRED` activo). |
| Quorum Portal (portal-api) | `/planQuorum/dev/quorum/` | (interno, jitsi-side via LTI) | LTI 1.3 OIDC `id_token` de Canvas | Fastify + `ltijs` valida el OIDC; anti-replay vía `portal-redis`. |
| Quorum OpenBao | (en `quorum/`) | `https://secret.inecuni.com/` | Token root + AppRole | Secrets management. Reemplaza a Vault en la nueva arquitectura. |
| Quorum Prometheus | (en `quorum/`) | `https://observability.inecuni.com/` | basic-auth (usuario `promadmin`; credencial gestionada fuera del repo) | Observabilidad (métricas). Scrapea `/metrics` del backoffice + jitsi + portal-api. |
| Quorum Storage (MinIO) | (en `quorum/`) | interno (S3-compatible) | service-account IAM | Almacenamiento de objetos (recordings, exports). |
| Quorum DR | (en `quorum/`) | interno (scripts operator-side) | SSH bastion + backups cifrados | Disaster recovery scripts. Fuera del runtime path. |
| Infra común | — | nginx del host `quorum` (216.225.193.226) | TLS via Let's Encrypt + certbot; nginx reverse proxy → k3s pods via `hostNetwork=true` | Reverse proxy unificado; el cluster k3s single-node `quorum` corre los pods en `216.225.193.226`. |

> **Nota**: cada workspace es un repo separado con su propio `package.json`
> + workspaces npm. Deploy per-namespace k3s (`quorum-backoffice`,
> `quorum-lms`, `quorum-media`, `quorum-storage`, `quorum-recording`,
> `quorum-observability`, `quorum-control`, `quorum-dr`).

## Acceso seed (Backoffice)

El script `apps/api/scripts/seed-e2e-users.ts` es un **fixture de E2E**
únicamente: se invoca manualmente con `npm run seed:e2e` (desde
`apps/api`) y **no** corre como parte del deploy ni del seed de
producción. La DB `quorum_backoffice` de producción se inicializa vía
migraciones + el procedimiento "Bootstrap admin user (production)" del
`RUNBOOK.md`. Cada campo del fixture es override-able por env vars
(`E2E_{ADMIN,AUDITOR,OPERATOR}_{EMAIL,USERNAME,PASSWORD}`).

| Rol | Email (default) | Username (default) | Rutas accesibles |
|---|---|---|---|
| `admin` | `admin@quorum.local` | `admin` | dashboard, marbetes, dispositivos, audit |
| `auditor` | `auditor@quorum.local` | `auditor` | dashboard, marbetes, dispositivos, audit (read-only) |
| `operator` | `operator@quorum.local` | `operator` | dashboard, marbetes, dispositivos (sin audit) |

**Login contract (OTP-only)**: `POST /api/v1/auth/login` acepta
`{ username, otp }` y **nunca** lee `users.password_hash`. El OTP se
pre-emite vía HMAC contra el servicio sibling `quorum-otp`. La columna
`password_hash` se conserva en disco por compatibilidad legacy pero
no participa en el flujo de login — el `admin1234` y demás valores
del fixture E2E son credenciales de prueba que solo existen en la DB
de desarrollo/E2E, no en producción.

**OTP**: en staging actual el servicio OTP apunta a `placeholder.invalid`,
así que las operaciones destructivas (create/update/delete/reveal/bulk)
requieren header `X-OTP-Code: 123456` y devuelven 503 `service_unavailable`
contra el placeholder. **Recomendado**: desactivar el enforcement en dev
local con `AUTH_OTP_REQUIRED=false` (env var) o apuntar a un OTP real
(`http://quorum-otp:8080`).

## Staging live

| Recurso | URL / endpoint | Estado |
|---|---|---|
| Backoffice Web | `https://backoffice.inecuni.com/backoffice/login` | ✅ live |
| Backoffice API healthz | `https://backoffice.inecuni.com/healthz` | 200 |
| Backoffice API readyz | `https://backoffice.inecuni.com/readyz` | 200 |
| Bulk endpoint | `POST /backoffice/api/v1/marbetes/bulk` | 401 sin auth, 401 `otp_required` sin OTP |
| Audit endpoint | `GET /backoffice/api/v1/audit?action=...&entityType=...` | auditor+ gated |

Pods (namespace `quorum-backoffice`):
- `quorum-backoffice-api-66c448fcf4-...` → port `4100` (hostNetwork)
- `quorum-backoffice-web-7ddf944fdd-...` → port `4002` (hostNetwork)

```bash
# Status rápido
kubectl -n quorum-backoffice get pods
curl -sS https://backoffice.inecuni.com/readyz
```

## Deploy

> ⚠️ El doc histórico `odd/tasks/deploy-bug-001.md` y esta sección
> (rsync + kubectl delete pod) describen un flujo **ssh + hostPath** que
> ya no aplica al cluster k3s real. Ver `RUNBOOK.md` § Operational tasks
> → Deploy para el flujo actualizado. La imagen del pod se construye en
> CI y se hace `kubectl set image` en el namespace `quorum-backoffice`.

Release real (single-node k3s cluster `quorum`, namespace `quorum-backoffice`):

1. Merge del feature a `master` (PR en GitHub o `git merge --no-ff` local + push).
2. El pipeline de CI build la imagen Docker de `apps/web` (Next.js 16 standalone) y la pushea al registry configurado.
3. ```bash
   kubectl -n quorum-backoffice set image deployment/quorum-backoffice-web \
     web=<registry>/quorum-backoffice-web:<tag>
   ```
4. ```bash
   kubectl -n quorum-backoffice rollout status deployment/quorum-backoffice-web --timeout=120s
   ```
5. Smoke check:
   ```bash
   curl -sk -o /dev/null -w 'login HTTP %{http_code}\n' https://backoffice.inecuni.com/login
   curl -sk -o /dev/null -w 'marbetes HTTP %{http_code}\n' https://backoffice.inecuni.com/backoffice/marbetes
   ```

Estado actual del cluster (verificado 2026-09-26):

```bash
$ kubectl -n quorum-backoffice get pods
NAME                                    READY   STATUS    RESTARTS   AGE
pod/quorum-backoffice-web-f6d9dd77-dwwxs 1/1    Running   0          7m
pod/quorum-backoffice-api-66c448fcf4-qw68n 1/1  Running   0          4d7h
```

## Quickstart (local)

```bash
# 1. Bootstrap local services (Postgres + Redis) — idempotente
bash scripts/dev-bootstrap.sh

# 2. Env vars
cp .env.example .env
cp apps/api/env.example apps/api/.env
cp apps/web/env.example apps/web/.env.local
# Editar: SESSION_SECRET (64+ chars), OTP_SERVICE_URL, etc.

# 3. Install
npm install

# 4. Migraciones + seed users
cd apps/api && npm run build
DATABASE_URL=postgresql://websop:quorum_backoffice_dev@127.0.0.1:5432/quorum_backoffice_dev \
  REDIS_URL=redis://127.0.0.1:6379 \
  OTP_SERVICE_URL=http://127.0.0.1:65535 \
  OTP_SERVICE_TOKEN=test \
  CANVAS_PORTAL_API_URL=http://127.0.0.1:65535 \
  CANVAS_PORTAL_API_TOKEN=test \
  SESSION_SECRET="$(head -c 64 /dev/urandom | base64)" \
  npm run seed:e2e

# 5. Dev (puertos DEV = 3xx)
npm run -w @quorum-backoffice/api dev    # API en :3100
npm run -w @quorum-backoffice/web dev    # Web en :3002

# 6. Tests
npm test                  # unit + integration
npx playwright test --config=apps/web/e2e/lookfeel/playwright.config.ts  # e2e (contra staging)
```

Puertos (convención):
- **DEV**: api `3100`, web `3002`
- **PROD**: api `4100`, web `4002` (ambos en hostNetwork vía k3s)

## Quality gates

```bash
npm run typecheck    # api + web + shared, strict TS
npm run lint         # api + web
npm test             # 194 verde (115 api + 21 api unit + 58 web RTL)
cd apps/web && npm run build  # 7 rutas verde
```

Coverage targets (mirror `quorum-otp`): lines/functions/statements ≥ 80%,
branches ≥ 70%.

## Estructura del repo

```
quorum-backoffice/
├── apps/
│   ├── api/                # Fastify 5 + TS (port 3100 dev / 4100 prod)
│   │   ├── migrations/      # 9 migrations (init → 0009_audit_action_bulk)
│   │   └── src/             # routes, services, repositories, plugins, scripts/seed-e2e
│   └── web/                # Next.js 16 + shadcn/ui (port 3002 dev / 4002 prod)
│       ├── app/             # /login, /(authed)/{dashboard,marbetes,dispositivos,audit}
│       ├── components/
│       │   ├── inventory/   # MetricCard, DonutChart, BulkUploadDialog, etc.
│       │   ├── layout/      # AppShell, Sidebar, Topbar, LogoutButton, MobileNav
│       │   └── ui/          # shadcn wrappers
│       ├── lib/             # api-client, server-session, auth-context
│       ├── e2e/lookfeel/   # Playwright suite (45 tests, contra staging)
│       └── test/unit/      # React Testing Library suite
├── packages/shared/         # Zod DTOs compartidos (AuditAction, BulkCreateMarbetes*, etc.)
├── odd/tasks/               # planes ODD + bitácora (quorum-backoffice-mvp.md + Polish WU vN.md)
├── diseno/                  # Brand tokens + InecConecta maquette
├── infra/                   # nginx + systemd (referencia; el deploy activo está en /opt)
├── scripts/dev-bootstrap.sh # Setup local de Postgres + Redis
├── HANDOFF.md               # prompt reutilizable al abrir nueva sesión Pi
├── RUNBOOK.md               # operador-facing (deploy + ops + alerts + DR)
└── README.md                # este archivo
```

## Documentos vivos

- **`HANDOFF.md`** — prompt reutilizable al abrir nueva sesión Pi. Carga
  contexto completo (estado, pendientes, comandos de validación).
- **`RUNBOOK.md`** — operador-facing. Deploy manual, health checks, alerts,
  DR.
- **`odd/tasks/quorum-backoffice-mvp.md`** — plan ODD + bitácora §12 con los
  16 work-units cerrados (WU0–WU13 + Polish WU v1/v2/v3 + WU #2 dispositivos v2
  + Polish WU v4 bulk + Polish WU v5 audit).
- **`odd/tasks/polish-wu-vN.md`** — planes de los polish batches.
- **`apps/web/e2e/lookfeel/`** — Playwright suite; cada `.spec.ts` documenta
  su scope en el header.

## Tareas recientes (Polish WU v4 + v5)

| Batch | WUs | Hash | Commits | LOC |
|---|---|---|---|---|
| **Polish WU v4** (bulk upload end-to-end) | WU #3 backend + WU #4 frontend + WU #9 housekeeping | `3f430bc` + `06fda3d` + `f45f7bf` → merge `f1fee3a` | 3 work-unit commits + merge | ~1250 |
| **Polish WU v5** (audit v2) | redesign + Playwright spec + closeout | `959a5fb` → merge `dc6e46b` + docs `657dee7` | 1 work-unit + merge + docs | ~750 |
| **Audit gap fix** (post-Playwright) | CSS overflow + logout 500 + 6 stale test selectors | `466c9f1` | 1 fix commit | ~45 |

Estado final: **44 ✅ / 1 ⏭ / 0 ❌** Playwright contra staging.
