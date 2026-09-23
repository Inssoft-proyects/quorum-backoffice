# Quorum Backoffice

Administrative backoffice for the Quorum suite. Owns the physical
security surface (security badges / "marbetes", authorized devices)
and the audit trail of every privileged action.

> **Status**: MVP COMPLETE + Polish WU v4 (bulk upload) + Polish WU v5 (audit v2).
> Master `657dee7..466c9f1`, staging live, **44/45 Playwright verde** contra
> `https://quorum.asistentepro.mx/backoffice/`.

## Tabla de sistemas (Quorum suite)

| Sistema | Workspace / repo | URL pública | Acceso (rol / método) | Descripción |
|---|---|---|---|---|
| **Quorum Backoffice** (este repo) | `/planQuorum/dev/quorum-backoffice/` | `https://quorum.asistentepro.mx/backoffice/login` | `admin@quorum.local` / `auditor@quorum.local` / `operator@quorum.local` + password seed (ver [§ Acceso seed](#acceso-seed-backoffice)) | Backoffice administrativo. Marbetes QR, dispositivos autorizados, audit log. **Polish WU v4** agregó bulk upload (`POST /api/v1/marbetes/bulk`); **Polish WU v5** rediseñó `/audit` per maquet InecConecta. |
| Quorum Backoffice API | (mismo workspace) | `https://quorum.asistentepro.mx/backoffice/api/v1/...` | Cookie `__Host-sid` (admin / auditor / operator) | API REST Fastify 5 + TS. Health: `GET /healthz`, ready: `GET /readyz`. OTP enforced en operaciones destructivas vía header `X-OTP-Code`. |
| Quorum Meet (Jitsi) | `/planQuorum/dev/quorum-jitsi/` | `https://quorum.asistentepro.mx/` | Libre (autoregistro) | Videoconferencia WebRTC. Jicofo + JVB + Prosody XMPP + Jibri recording. |
| Quorum LMS (Canvas) | `/planQuorum/dev/quorum-canvas/` | `https://canvas.asistentepro.mx/` (planeado; namespace k3s `quorum-lms` vacío) | LTI 1.3 launch desde Jitsi | LMS aislado de portal-api. LMS-side scripts (reconcile roster, one-shot import, force-sync) corren operator-side. |
| Quorum OTP | `/planQuorum/dev/quorum-otp/` | `http://127.0.0.1:8080/ui/` (dev) / `OTP_SERVICE_URL` (prod, ver configMap) | `E2E_OTP_*` env vars en deployment | Servicio OTP para operaciones destructivas. **En staging actual está en `http://placeholder.invalid/v1`** (modo bypass — destructive ops devuelven 401 `otp_required` con el flag `AUTH_OTP_REQUIRED` activo). |
| Quorum Portal (portal-api) | `/planQuorum/dev/quorum/` | (interno, jitsi-side via LTI) | LTI 1.3 OIDC `id_token` de Canvas | Fastify + `ltijs` valida el OIDC; anti-replay vía `portal-redis`. |
| Quorum OpenBao | (en `quorum/`) | `https://openbao.quorum.asistentepro.mx/` | Token root + AppRole | Secrets management. Reemplaza a Vault en la nueva arquitectura. |
| Quorum Prometheus | (en `quorum/`) | `https://prometheus.quorum.asistentepro.mx/` | basic-auth (admin / admin) | Observabilidad (métricas). Scrapea `/metrics` del backoffice + jitsi + portal-api. |
| Quorum Storage (MinIO) | (en `quorum/`) | interno (S3-compatible) | service-account IAM | Almacenamiento de objetos (recordings, exports). |
| Quorum DR | (en `quorum/`) | interno (scripts operator-side) | SSH bastion + backups cifrados | Disaster recovery scripts. Fuera del runtime path. |
| Infra común | — | `quorum.asistentepro.mx` | TLS via Let's Encrypt + certbot; nginx reverse proxy → k3s pods via `hostNetwork=true` | Reverse proxy unificado; el cluster k3s single-node `quorum` corre los pods en `216.225.193.226`. |

> **Nota**: cada workspace es un repo separado con su propio `package.json`
> + workspaces npm. Deploy per-namespace k3s (`quorum-backoffice`,
> `quorum-lms`, `quorum-media`, `quorum-storage`, `quorum-recording`,
> `quorum-observability`, `quorum-control`, `quorum-dr`).

## Acceso seed (Backoffice)

Usuarios seeded en la DB `quorum_backoffice` (production) vía
`apps/api/scripts/seed-e2e-users.ts`. La password se override por env vars
(`E2E_{ADMIN,AUDITOR,OPERATOR}_{EMAIL,PASSWORD}`).

| Rol | Email | Password (production seed) | Rutas accesibles |
|---|---|---|---|
| `admin` | `admin@quorum.local` | `admin1234` | dashboard, marbetes, dispositivos, audit |
| `auditor` | `auditor@quorum.local` | `auditor1234` | dashboard, marbetes, dispositivos, audit (read-only) |
| `operator` | `operator@quorum.local` | `operator1234` | dashboard, marbetes, dispositivos (sin audit) |

**OTP**: en staging actual el servicio OTP apunta a `placeholder.invalid`,
así que las operaciones destructivas (create/update/delete/reveal/bulk)
requieren header `X-OTP-Code: 123456` y devuelven 503 `service_unavailable`
contra el placeholder. **Recomendado**: desactivar el enforcement en dev
local con `AUTH_OTP_REQUIRED=false` (env var) o apuntar a un OTP real
(`http://quorum-otp:8080`).

## Staging live

| Recurso | URL / endpoint | Estado |
|---|---|---|
| Backoffice Web | `https://quorum.asistentepro.mx/backoffice/login` | ✅ live |
| Backoffice API healthz | `https://quorum.asistentepro.mx/healthz` | 200 |
| Backoffice API readyz | `https://quorum.asistentepro.mx/readyz` | 200 |
| Bulk endpoint | `POST /backoffice/api/v1/marbetes/bulk` | 401 sin auth, 401 `otp_required` sin OTP |
| Audit endpoint | `GET /backoffice/api/v1/audit?action=...&entityType=...` | auditor+ gated |

Pods (namespace `quorum-backoffice`):
- `quorum-backoffice-api-66c448fcf4-...` → port `4100` (hostNetwork)
- `quorum-backoffice-web-7ddf944fdd-...` → port `4002` (hostNetwork)

```bash
# Status rápido
kubectl -n quorum-backoffice get pods
curl -sS https://quorum.asistentepro.mx/readyz
```

## Deploy

Procedimiento (per `RUNBOOK.md`):

```bash
# 1. Sync dev tree al deploy path del VPS
rsync -a --delete --exclude=node_modules --exclude=.next --exclude=dist --exclude=.git \
  --exclude='apps/web/test-results' \
  /planQuorum/dev/quorum-backoffice/ /opt/quorum-backoffice/

# 2. Build
sudo -n -H bash -c 'cd /opt/quorum-backoffice/packages/shared && rm -f tsconfig.tsbuildinfo && npm run build'
sudo -n -H bash -c 'cd /opt/quorum-backoffice/apps/api && rm -f tsconfig.tsbuildinfo && npm run build'
sudo -n -H bash -c 'cd /opt/quorum-backoffice/apps/web && rm -rf .next && NEXT_PUBLIC_API_URL=https://quorum.asistentepro.mx/backoffice npm run build'

# 3. **CRÍTICO** — Next.js 16 standalone NO copia .next/static/ automáticamente
sudo -n -H bash -c 'cd /opt/quorum-backoffice/apps/web && cp -r .next/static .next/standalone/apps/web/.next/ && [ -d public ] && cp -r public .next/standalone/apps/web/'

# 4. Restart pods
kubectl -n quorum-backoffice delete pod -l app.kubernetes.io/name=quorum-backoffice-api --force --grace-period=0
kubectl -n quorum-backoffice delete pod -l app.kubernetes.io/name=quorum-backoffice-web --force --grace-period=0
sleep 25

# 5. Smoke
curl -sS https://quorum.asistentepro.mx/readyz  # → 200
curl -sS https://quorum.asistentepro.mx/backoffice/_next/static/chunks/0q4kif52npia0.css  # → 200
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
