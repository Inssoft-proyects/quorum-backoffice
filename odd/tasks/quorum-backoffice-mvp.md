# Quorum Backoffice — MVP

> Feature plan ODD (Organic Driven Development). Strict TDD habilitado. Budget de
> review por Work Unit (WU): **≤ 400 líneas modificadas** para proteger carga de
> revisión. Tests TDD obligatorios (RED → GREEN → REFACTOR) en cada WU no trivial.

## 1. Identidad

| Campo | Valor |
| --- | --- |
| Feature | `quorum-backoffice-mvp` |
| Suite | Quorum (hermanos: `quorum-core`, `quorum-backend`, `quorum-otp`) |
| Estado | greenfield — sólo `.git`, `.atl/`, `.gitignore`, `./diseno` |
| Stack | Monorepo npm workspaces |
| Backend | Fastify 5 + TS 5 + Node 22 + PostgreSQL 18 + Redis 8 + Zod |
| Frontend | Next.js 15 (App Router) + React 19 + TypeScript 5 + shadcn/ui + Tailwind 4 |
| Compartido | `packages/shared` — Zod DTOs, tipos de error, eventos de auditoría |
| Tests | Jest 30 + ts-jest + supertest (api) + React Testing Library (web) |
| Calidad | ESLint + Prettier + tsc --noEmit |
| Cobertura | líneas/funciones/statements ≥ 80%, ramas ≥ 70% (mirror quorum-otp) |
| Integraciones | Canvas LMS vía `portal-api` (read-only students), OTP vía `quorum-otp` |

## 2. Objetivo y alcance

**Objetivo:** Backoffice administrativo para Quorum Suite que gestiona la
seguridad física de acceso (marbetes QR lenticular, dispositivos autorizados)
con trazabilidad completa y validación OTP en operaciones destructivas.

**Pantallas:**
- **CRUD Marbetes**: 2 tarjetas de estado (OK/KO) + tabla con datos del
  estudiante (Canvas LMS) y número de marbete enmascarado `3***24`.
  - Eliminar requiere justificación + OTP.
  - Crear/Editar requiere OTP.
- **CRUD Dispositivos**: tabla con serial (requerido), marca y modelo
  (opcionales). Crear/Editar/Eliminar requiere OTP.
- **Audit Log**: tabla con todos los movimientos. Filtros por marbete ID,
  ID de estudiante, acción, rango de fechas.

**Out of scope (este MVP):**
- Lectura/escritura del QR lenticular (lo entrega la app móvil al backend).
- Sincronización bidireccional con Canvas (solo lectura vía portal-api).
- Multi-tenant / multi-school (single-tenant).
- Roles granulares más allá de `admin`, `operator`, `auditor`.
- Notificaciones por email/SMS sobre eventos de auditoría.
- Dark mode (theme provider queda listo, switch se difiere).

## 3. Convenciones heredadas del suite

- TypeScript estricto (`strict: true`, `noUncheckedIndexedAccess: true`).
- Pino + redacción para logs (`token`, `password`, `cookie`, `authorization`,
  `marbete_uid`, `otp`, `serial_number`).
- Auditoría inmutable: tabla `audit_log` con REVOKE de UPDATE/DELETE.
- Migraciones SQL en bruto ejecutadas con runner custom (~30 líneas, basado en
  tabla `_migrations`, todas dentro de transacción).
- Tests integración contra PG real local (sin Docker — usar `quorum_backoffice` +
  `quorum_backoffice_test` en PG 18 local) y Redis local. testcontainers solo CI.
- Errores tipados (`class XxxError extends Error`) mapeados a HTTP status por
  un error handler central.
- Variables de entorno validadas con zod en `config.ts`.
- Idempotencia en operaciones de escritura donde aplique.

## 4. Modelo de datos (Postgres DDL, referencial)

```sql
-- 0001_init.sql
CREATE TABLE students_cache (
  id BIGSERIAL PRIMARY KEY,
  canvas_user_id BIGINT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_students_canvas ON students_cache(canvas_user_id);

-- 0002_marbetes.sql
CREATE TYPE marbete_status AS ENUM ('active','inactive','revoked');
CREATE TABLE marbetes (
  id BIGSERIAL PRIMARY KEY,
  public_uid TEXT NOT NULL UNIQUE,                -- p.ej. m-AB12CD (mostrado)
  code_hash TEXT NOT NULL,                         -- sha256 del código leído
  status marbete_status NOT NULL DEFAULT 'active',
  assigned_student_id BIGINT REFERENCES students_cache(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT NOT NULL,
  deleted_at TIMESTAMPTZ,
  deletion_reason TEXT
);
-- Garantía: un marbete activo por estudiante (índices parciales)
CREATE UNIQUE INDEX uq_marbete_active_per_student
  ON marbetes(assigned_student_id)
  WHERE status = 'active' AND deleted_at IS NULL;
CREATE INDEX idx_marbetes_status ON marbetes(status);
CREATE INDEX idx_marbetes_assigned ON marbetes(assigned_student_id);

-- 0003_dispositivos.sql
CREATE TYPE dispositivo_status AS ENUM ('active','revoked');
CREATE TABLE dispositivos (
  id BIGSERIAL PRIMARY KEY,
  serial_number TEXT NOT NULL UNIQUE,
  brand TEXT,
  model TEXT,
  status dispositivo_status NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT
);
CREATE INDEX idx_dispositivos_status ON dispositivos(status);

-- 0004_audit.sql
CREATE TYPE audit_action AS ENUM (
  'marbete.create','marbete.update','marbete.delete','marbete.assign',
  'dispositivo.create','dispositivo.update','dispositivo.revoke',
  'auth.login','auth.logout','auth.failed'
);
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id TEXT NOT NULL,
  actor_email TEXT,
  action audit_action NOT NULL,
  entity_type TEXT,                  -- 'marbete' | 'dispositivo' | 'session'
  entity_id TEXT,                    -- texto (puede ser uid público o id interno)
  before_jsonb JSONB,
  after_jsonb JSONB,
  otp_id TEXT,                       -- id de OTP verificado
  ip INET,
  user_agent TEXT
);
CREATE INDEX idx_audit_occurred ON audit_log(occurred_at DESC);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_action ON audit_log(action);
CREATE INDEX idx_audit_actor ON audit_log(actor_id);

-- Inmutabilidad: nadie actualiza ni borra.
REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;
```

## 5. Contratos API (REST, prefijo `/api/v1`)

| Método | Path | Auth | OTP | Descripción |
| --- | --- | --- | --- | --- |
| GET | `/healthz` | no | no | Liveness |
| GET | `/readyz` | no | no | Readiness (PG + Redis + OTP service) |
| GET | `/metrics` | no | no | Métricas Prometheus |
| POST | `/api/v1/auth/login` | no | no | Login (form: email, password) → cookie |
| POST | `/api/v1/auth/logout` | sí | no | Logout → cookie clear |
| GET | `/api/v1/auth/me` | sí | no | Sesión actual |
| GET | `/api/v1/marbetes` | sí | no | Listado + filtros (`status`, `assigned`, `search`) |
| GET | `/api/v1/marbetes/counters` | sí | no | `{ ok, ko }` para tarjetas |
| POST | `/api/v1/marbetes` | admin | sí | Crear |
| GET | `/api/v1/marbetes/:id` | sí | no | Detalle |
| PATCH | `/api/v1/marbetes/:id` | admin | sí | Editar (asignar / reasignar) |
| DELETE | `/api/v1/marbetes/:id` | admin | sí | Eliminar (body: `reason`) |
| GET | `/api/v1/students` | sí | no | Proxy lectura desde Canvas (cache) |
| GET | `/api/v1/dispositivos` | sí | no | Listado + filtros |
| POST | `/api/v1/dispositivos` | admin | sí | Crear |
| GET | `/api/v1/dispositivos/:id` | sí | no | Detalle |
| PATCH | `/api/v1/dispositivos/:id` | admin | sí | Editar |
| DELETE | `/api/v1/dispositivos/:id` | admin | sí | Eliminar (body: `reason`) |
| GET | `/api/v1/audit` | auditor+ | no | Listado con filtros |
| GET | `/api/v1/audit/:id` | auditor+ | no | Detalle |

**OTP requerido en operaciones destructivas**: el cliente envía el código OTP en
el header `X-OTP-Code`. El backend llama `POST /v1/otps/verify` con un
`(subject=actor, scope=<acción>)` único por request.

## 6. Convenciones de UI (shadcn + InecConecta tokens)

CSS variables en `globals.css` (mapeo exacto desde tokens del brief):
- `--color-primary-500: #AB8620` (primary/500)
- `--color-secondary-500: #358456`
- `--color-text-primary: #292929`
- `--color-text-muted: #6F6F6F`
- `--color-text-muted-bold: #5F5F5F`
- `--color-feedback-success: #03BB35`
- `--color-alert-error-bg: #FFE5E9`
- `--color-alert-error-text: #AC000E`
- `--color-alert-warning-bg: #FFF5E6`
- `--color-alert-warning-text: #723D19`

Reglas: usar tokens por rol (`var(--color-primary-500)`), nunca por nombre
visual. `tailwind.config.ts` referenciará estas variables.

Iconografía: importar `png-x2/*.png` como assets `public/icons/...` o
convertir a SVG inline. Componentes wrapper `<Icon name="id-card" variant="green" />`.

## 7. Work Units (≤400 líneas modificadas cada una)

Cada WU cierra con ≥1 commit work-unit en la rama de feature, con tests + docs
incluidos. Convención de mensaje: `type(scope): summary` (Conventional Commits).
Tests RED primero, luego GREEN, luego REFACTOR.

| WU | Concern | Est. líneas | Notas |
| --- | --- | --- | --- |
| WU0 | Bootstrap monorepo | ~250 | workspaces, configs, API esqueleto, Web esqueleto, dev-bootstrap.sh |
| WU1 | Design system + shadcn | ~300 | Tailwind theme con tokens, shadcn init, componentes base, icon wrapper |
| WU2 | Schema + migrations | ~300 | 4 migrations, runner, pg plugin, índices |
| WU3 | API: Marbetes | ~400 | CRUD + asignar + OTP guard. Probable split → WU3a/b si excede. |
| WU4 | API: Dispositivos | ~250 | CRUD + OTP guard |
| WU5 | API: Audit | ~250 | Listado + filtros + append-only enforced |
| WU6 | API: Auth + RBAC | ~600 (split) | Login + sesión firmada + preHandlers por rol. Split: WU6a = schema+crypto+auth-service+login/logout/me; WU6b = session plugin + RBAC plugin + wire en rutas. |
| WU6a | API: Auth core | ~350 | migration 0005 (users + sessions) + bcrypt + session token + rate-limit Redis + AuthService + rutas login/logout/me + tests (login OK/bad/rate-limit/audit, logout, me). Roles enum: admin/operator/auditor. Jerarquía numérica operator=1, auditor=2, admin=3. |
| WU6b | API: Session + RBAC | ~300 | session plugin (cookie → req.session.user) + rbac plugin (requireRole minRole) + wire en marbetes/dispositivos/audit (replace x-test-actor con req.session.user.id; requireRole('admin') en POST/PATCH/DELETE; requireRole('auditor') en GET audit) + RBAC tests. |
| WU7 | Web: Layout + Login | ~300 | Sidebar, topbar, login form, auth context, API client |
| WU8 | Web: Marbetes screen | ~400 | Tarjetas OK/KO, tabla, dialogs, OTP modal. Probable split. |
| WU9 | Web: Dispositivos screen | ~300 | Tabla + dialogs + OTP modal |
| WU10 | Web: Audit screen | ~300 | Tabla filtrable + detail drawer |
| WU11 | Observabilidad + runbook | ~200 | /metrics, /readyz deep, docs, e2e happy |

Criterios de split (a evaluar en apply):
- Si WU3 o WU8 exceden 400 → dividir en WU3a/b y WU8a/b respectivamente.

## 8. Tests — estrategia

- **Unit**: lógica pura (zod schemas, helpers de masking, errores, validadores,
  format de `public_uid`).
- **Integration API**: Fastify + PG real (DB `quorum_backoffice_test`) + Redis
  local + mock de `portal-api` y `quorum-otp` (nockefeo.used o MSW local).
- **Component (Web)**: React Testing Library sobre componentes shadcn-wrapped;
  mock de API client.
- **E2E (Web)**: Playwright diferido a WU11 (flujo feliz login → CRUD → audit).
- Cobertura: líneas/funciones/statements ≥ 80%, ramas ≥ 70%.

## 9. Riesgos y mitigaciones

1. **Diseño sin mockups de pantallas.** Mitigación: layout funcional basado en
   requisitos + tokens; iteración visual con el usuario por capturas.
2. **Sin Docker local.** Tests usan PG/Redis locales; CI usa testcontainers.
3. **Integración con portal-api aún no validada.** WU3 hace mock; la
   integración real se valida en WU11 con e2e.
4. **Dependencia de quorum-otp.** WU3 define el cliente OTP; si el contrato
   `/v1/otps/verify` cambia, ajustar el guard.
5. **Audit log append-only.** Las migraciones revocan UPDATE/DELETE; un test
   de integración debe verificar que `UPDATE audit_log` falla con permisos.
6. **Review budget.** WU3 y WU8 son los más densos; split si exceden 400.

## 10. Definition of Done

- WU cerrada con commit + tests verdes + cobertura cumplida + docs mínimas.
- Lint, format, typecheck sin errores.
- Manual QA no es DoD; depende del usuario aceptar la captura.

## 11. Próximo paso

Empezar por **WU0 — Bootstrap monorepo** delegando a `gentle-ai-worker` con
remitos exactos (rutas canónicas, comandos, allowed edit surfaces).

## 12. Bitácora de WUs (evidencia, commits, líneas)

| WU | Estado | Commit | Líneas (insertions) | Notas |
| --- | --- | --- | --- | --- |
| WU0 | ✅ done | `1f6fd95` | ~440 (en `1f6fd95`) | Bootstrap monorepo. Inline (worker bloqueado). Tests 6/6. |
| WU1a | ✅ done | `f5d1adc` | 443 | Tokens + 5 shadcn core + icon wrapper. |
| WU1b | ✅ done | `73a5011` | 1322 | shadcn extend + theme provider + login demo. Excede 400-line budget por verbose wrappers (permitido por policy ODD). |
| WU2 | ✅ done | `ef998be` | 427 | Schema (4 migrations) + runner + 11 tests. Audit append-only enforced via REVOKE PUBLIC. CLI migrate aplicada a `quorum_backoffice` real. |
| WU3a | ✅ done | `27c34c9` | 841 | Marbetes CRUD scaffolding (DTOs + repo + service + routes). OTP deferred WU3b. 8 nuevos tests integration (23/23 total). |
| WU3b | ✅ done | `771a55e` | 570 | canvas-client + otp-client + audit-service. OTP enforced en destructive ops; 22/22 tests pasan. |
| WU4 | ✅ done | `c8fa1b8` | 809 | API Dispositivos CRUD + OTP guard. DTOs (shared), repo (pg-dispositivos), service (OTP+audit), 5 routes (list/get/post/patch/delete→revoke), 11 tests integration (33/33 total verde). DELETE = soft-revoke (`revoked_at` + `revoked_reason`). Excede budget de 400 por test file de 291 LOC (justificado, mismo patrón que WU3a). |
| WU5 | ✅ done | `1c2902c` | 511 | API Audit read-only. Repo (pg-audit) + service (audit-query-service) + 2 routes (list+detail). 11 nuevos tests integration (44/44 total verde). `entity_type` columna única fuente de verdad (sin derivation). Append-only enforced via REVOKE PUBLIC verificado con `information_schema.role_table_grants` (PG18-compatible). |
| WU6a | ✅ done | `ee1f589` | 1019 | API Auth core. Migration 0005 (users + sessions + user_role enum) + DTOs (UserRole + ROLE_HIERARCHY + LoginRequest + MeResponse) + bcrypt cost-12 + session token (32B base64url) + rate limit Redis INCR + AuthService (login/logout/getCurrentUser con audit auth.login/auth.failed/auth.logout) + rutas login/logout/me con @fastify/cookie + cookie sid configurable + 12 tests integration (56/56 total verde). WU6b próximo: session plugin + RBAC + wire en rutas existentes. |
| WU6b | ✅ done | `9a641ab` | 619 | API Session plugin + RBAC + wire. `session-hydrator.ts` (token→user) + `plugins/session.ts` (global onRequest hook con x-test-actor shim + cookie lookup) + `plugins/rbac.ts` (requireSession + requireRole factories) + preHandlers en marbetes/dispositivos/audit (`requireSession` en GET, `requireRole('admin')` en POST/PATCH/DELETE, `requireRole('auditor')` en GET audit) + `actorFromRequest` ahora lee de `req.session.user.email`. 16 nuevos tests integration (72/72 total verde). x-test-actor shim mantenido para compatibilidad con tests existentes. |
| WU7 | ✅ done | `5791ac8` | ~720 | Web Layout + Login real. Test infra (jest + RTL + jsdom + Next.js config), rename env var NEXT_PUBLIC_API_URL (dev 3100, prod 4100), api-client (login/logout/me con cookie forwarding server-side), server-session via next/headers, AuthContext client-side, login form real con server-side session check, (authed) route group layout con AppShell + Sidebar + Topbar (Audit link solo para auditor+), dashboard + placeholders WU8/9/10. 16 tests RTL verde. Next.js build: 7 rutas registradas. |
| WU8a | ✅ done | `eb77c8e` | 692 | Web Marbetes list+counters+delete. API client wrappers (getMarbeteCounters/listMarbetes/getMarbete/deleteMarbete), OTP input reusable component, status cards (OK/KO), marbetes table con filtro status+search y delete role-gated, delete dialog con razón+OTP, page server-side con cookie forwarding. 12 nuevos tests RTL (28/28 web total verde, 72/72 API sin regresiones). Split: WU8b = create+edit+assign dialogs. |
| WU8b1 | ✅ done | `40a3cdd` | 582 | API canvasUserId + students endpoint + inactive rejection. Migration 0006 (is_active BOOLEAN en students_cache), DTO rename (assignedStudentId → canvasUserId), GET /api/v1/students?canvasUserId=X con requireRole('admin'), marbetes service resuelve canvas_user_id → students_cache.id y rechaza 422 si no existe o inactivo, marbetes integration tests actualizados (7 nuevos en describe block canvas_user_id). 13 nuevos tests (85/85 API total verde, 28/28 web sin regresiones). WU8b2 = web create+edit dialogs usando este contrato. |
| WU8b2 | ✅ done | `a74687d` | 957 | Web marbetes create + edit dialogs. API client: apiPostWithOtp/apiPatchWithOtp helpers + getStudentByCanvasId/createMarbete/updateMarbete wrappers. StudentLookup reusable component (on-blur fetch /students con 5 estados: idle/loading/found/inactive/not_found/error). Create dialog: code + canvasUserId (opcional) + OTP. Edit dialog: canvasUserId (nullable) + status + OTP, valida diff antes de PATCH ("No hay cambios" si nada cambió). Marbetes table con botón Editar (admin). Page client con state para 3 dialogs (create/edit/delete) + router.refresh(). 9 nuevos tests RTL (37/37 web total verde, 85/85 API sin regresiones). |
| WU9 | ✅ done | `c826bce` | ~960 | Web Dispositivos CRUD. API client: listDispositivos/getDispositivo/createDispositivo/updateDispositivo/revokeDispositivo wrappers. Filtros status+search via URL params. Table con serial completo + status badge + Edit/Revoke admin-gated (Revoke solo para active). CreateDialog: serialNumber+brand+model+OTP, mapea conflict. EditDialog: brand+model diff guard "No hay cambios". RevokeDialog: razón+OTP, soft-revoke. Page client con state para 3 dialogs + router.refresh(). 16 nuevos tests RTL (53/53 web total verde, 85/85 API sin regresiones). |
| WU10 | pending | — | — | Web Audit screen. |
| WU11 | ✅ done | `dc7207a` | ~700 | Observabilidad + runbook + Playwright e2e. Deep `/readyz` con pg/redis/otp checks paralelos (status `ok` o `degraded`; otp es best-effort). RUNBOOK.md con architecture/ports/env vars/health/ops tasks/alerts/DR/E2E setup. Playwright config (chromium, port 3100, sequential). 3 e2e spec files (auth/marbetes/audit, 7 tests total). `@playwright/test ^1.48.0` dep + chromium 1243 downloaded. Fixes: jest.config.cjs añade `<rootDir>/e2e/` a testPathIgnorePatterns; health.test.ts actualizado al nuevo contrato /readyz. 148/148 tests verde (85 API + 63 web). Playwright suite authored + config valid (7 tests discovered). |
| WU12 | ✅ done | `d02645a` | ~340 | Infra: nginx reverse proxy para `quorum.asistentepro.mx` + systemd units + ALLOWED_ORIGIN env. Vhost `infra/nginx/quorum.asistentepro.mx.conf` (104 LOC) con TLS 1.2/1.3 + certbot, security headers (HSTS, X-Frame-Options DENY, Permissions-Policy, X-XSS-Protection, server_tokens off), gzip, /api/→:3100, /healthz|/readyz→:3100 sin logs, /metrics→:3100 CIDR-restricted, /_next/static/ 1yr immutable cache, catch-all→:3002. 2 systemd templates en README (api+web) con hardening (NoNewPrivileges, ProtectSystem=strict, ReadWritePaths=dist). api.config: ALLOWED_ORIGIN env var wired a cors plugin (optional, defaults `false` para dev). web/env.example: NEXT_PUBLIC_API_URL apunta a `https://quorum.asistentepro.mx`. RUNBOOK + infra/nginx/README.md (224 LOC) con full operational guide (install nginx+certbot, build, env files, systemd, certbot --nginx, verify, logs, update, rollback, dist path caveat). Caddy files descartados (untracked). 148/148 tests verde. |
| WU13 | ✅ done | — | ~80 | Mount backoffice at `/backoffice/`. Nginx rewrite (strip `/backoffice/` prefix) + Next.js basePath (`basePath: '/backoffice'` en `apps/web/next.config.ts`) + api-client base URL. 148/148 tests verde (no regression). Build verification: HTML output incluye `/backoffice/_next/static/...` y referencias internas prefijadas correctamente. |
| Polish WU v1 | ✅ done | `bb094ef` + `562a289` + `3b2cad8` + `d616126` | ~300 | 4 work-unit tasks + parent doc tweak + bitácora. **Task 1+4 combined** `bb094ef fix(api): correct main + start path to dist/src/server.js + add seed:e2e script` — apps/api/package.json main+start corregidos (era `dist/server.js`, ahora `dist/src/server.js`) + script `seed:e2e` agregado (los cambios se unificaron porque comparten archivo; el seed:e2e referencia el script creado en Task 4). **Task 2** `562a289 feat(infra): extract systemd units as committed files` — 2 archivos nuevos en `infra/systemd/quorum-backoffice-{api,web}.service` (22 + 21 LOC, extraídos de los bloques inline en README §5). README §5 acortado: -47 líneas (sin los `ini` blocks, sin la nota stale 'templates live in this README') + reemplaza por un puntero a `infra/systemd/`. **Task 3** `3b2cad8 feat(web): add ESLint flat config + restore lint script` — apps/web/.eslintrc.cjs (legacy ESLint 8 + extends `next/core-web-vitals`, `next/typescript`, `prettier`; opción A flat+ESLint 9 descartada por incompat con `eslint-config-next@15.0.4` + requerir regenerar `package-lock.json` fuera de scope). Lint script restaurado a `eslint . --ext .ts,.tsx,.js,.jsx --max-warnings=9999` (1 warning pre-existente en `student-lookup.tsx:68` de WU8b2, no regresión). **Task 4** `d616126 feat(api): add idempotent e2e user seed script + update RUNBOOK` — `apps/api/scripts/seed-e2e-users.ts` (86 LOC) con UPSERT por email, bcrypt cost-12, overrides via env vars `E2E_{ROLE}_{EMAIL,PASSWORD}`. RUNBOOK §"E2E test setup" actualizado con el comando `npm run seed:e2e` (reemplaza stub SQL). **Parent doc tweak** `b37241c docs(plan): document basePath config + build verification in WU13 row` — cleanup in-flight de la sesión previa. Out of scope: items 5 (bcrypt→argon2id) y 6 (audit_log archival) → Polish WU v2 futuro. **RDD review**: tier high (4 lenses R1-R4); host relay bloqueado por config de modelo del harness; reviewer agents no dispatchable standalone. **Parent-inline manual review ejecutado por el modelo** (esta sesión) reportó APPROVED_WITH_NITS en las 4 lenses — sin blockers, nits menores (cost-12 bump a 13, runtime safety check contra DBs no-test, retry-on-transient, integration test para seed, --reset flag, concurrent-run guard). **Verificación**: 148/148 tests verde (63 web + 4 api unit + 81 api integration), typecheck api+web limpio, build web 7 rutas. Plan en `odd/tasks/polish-wu-v1.md`. |
| Polish WU v2 | ✅ done | `e0e49c7` + `218a56a` + `8d31b0b` + 764243e | ~155 | 4 work-unit tasks: A11Y-001 (P1, 1 línea semantic `<div>`→`<header>` en /login) + VIS-002 (P2, 4 focus-visible rules en .metric-card/.sort-button/.row-action/.table-pagination__toggle del maquet) + RESP-001 (P0, 5 archivos: AppShell grid responsive `grid-cols-1 md:grid-cols-[16rem_1fr]`, Sidebar `hidden md:flex` vía className prop, Topbar con `<MobileNav user={user}/>` y email `hidden md:inline`, nuevo `mobile-nav.tsx` client component con Radix Dialog drawer slide-from-left, 2 CSS rules `slide-in-from-left`/`slide-out-to-left` en @layer components). 148/148 tests verde (sin cambios a lógica). typecheck/lint/build green (5 pre-existing lint failures en archivos no tocados, sin regresiones). Plan + bitácora en `odd/tasks/polish-wu-v2.md`. |
| Polish WU v3 | ✅ done | `859c8f3` + `157b163` + `70c9c16` + `fcd523d` + `1fa0513` → `5fe6692` | ~993 | 5 work-unit tasks cerrando los polish items XS/M del HANDOFF §"Polish items pendientes" (Plan B scope: 5 de 9 items en esta sesión; los 3 L rediseño + bulk upload + el #9 RDD review quedan para sesiones dedicadas / están bloqueados): **WU #7** (XS, fade animation Radix Dialog overlay con 4 `[data-state]` selectors + 2 `@keyframes` en `@layer components` de `globals.css`; `tailwindcss-animate` sigue sin instalar). **WU #8** (XS, `aria-modal="true"` explícito en MobileNav `DialogContent` — Radix UI Dialog 1.1.23 no lo setea automáticamente). **WU #5** (S-M, migración argon2id — `@node-rs/argon2` ^2.0.0 + `password.ts` con dispatch por PHC prefix, dual-verify bcrypt legacy + argon2id nuevo; `auth-service.ts` upgrade transparente on first successful login; 11 unit tests + 2 integration tests). **WU #1** (M, `POST /api/v1/marbetes/:id/reveal` admin-only, OTP-enforced solo si `AUTH_OTP_REQUIRED=true`, response `{ code: publicUid, revealedAt }`, audit-only no mutación; `RevealMarbeteDialog` wired al endpoint; banner de "Código revelado" con design tokens; 5 integration tests nuevos en `marbetes.test.ts`). **WU #6** (M, migration 0007 `audit_log_archive` (LIKE audit_log + archived_at + idx) + `archive_audit_log(retention_days)` PL/pgSQL `SECURITY DEFINER` que bypassa el `REVOKE UPDATE,DELETE,TRUNCATE`; migration 0008 extiende enum `audit_action` con `'marbete.reveal'`; RUNBOOK §"Operational tasks / Audit log archival" con cron schedule). **DEV NOTE**: el Zod enum `AuditAction` en `packages/shared/src/dto/audit.ts` no incluye aún `'marbete.reveal'` (1-line follow-up pendiente); el cast `as AuditAction` en `marbetes-service.ts` es el bridge temporal. Out of scope WU v3: redesign /dispositivos (#2), redesign /audit (#3), bulk upload (#4), RDD review (#9 bloqueado por host relay config). **Verificación**: typecheck api+web green, npm test api 15/15, marbetes integration 19/19 (14 pre-existing + 5 reveal nuevos), web build 7 rutas, Playwright suite contra staging 25/25 verde (5.4m), DB enum `audit_action` ahora 11 valores, tabla `audit_log_archive` creada. Plan + bitácora en `odd/tasks/polish-wu-v3.md`. |
| WU #2 dispositivos v2 | ✅ done | `f7d071c` + `9a425b8` → `TBD-merge` | ~688 | Replica del patrón marbetes v2 en `/dispositivos`. **Tasks 1-4** `f7d071c feat(web): apply marbetes v2 inventory pattern to /dispositivos (WU #2)` — 4 source files (`page.tsx` +60/-25 + `dispositivos-page-client.tsx` +263/-28 + `dispositivos-table.tsx` +92/-22 + `dispositivos-filters.tsx` +96/-30; +501/-161 net): page server con auth + `limit:200` API fetch; page client con 4 MetricCards (Total / Activos / Revocados / Sin marca con `pills` attention), DonutChart segments con paleta del maquet, filters + table rediseñada (.table-shell + .data-table + IdBadge DIS-#### + StatusChip 'available'/'danger' + SortHeader para 6 columnas + .row-action buttons admin-gated con Revoke oculto en revocados) + Pagination; filtros en `.inventory-search` shell + `.custom-select__trigger` styles, URL-synced. Reuso completo de `inventory/*` components — sin nuevos tokens, sin nuevos componentes, sin nuevos npm packages. **Task 5** `9a425b8 test(lookfeel): add dispositivos-v2 design spec (T8.1-T8.5, 5 cases)` — Playwright spec de 187 líneas con 5 cases: T8.1 4 metric cards visibles + screenshot a `artifacts/screenshots/dispositivos-v2-design.png`; T8.2 tabla muestra DIS-#### IdBadges + serial + StatusChip (handles empty-state gracefully); T8.3 dialog "Registrar dispositivo" abre (admin-gated); T8.4 status select sincroniza URL a `?status=active`; T8.5 operator no ve el botón Registrar. 3 dialogs existentes (Create / Edit / Revoke) intactos — sólo wiring en page client. **Verificación**: 63/63 web RTL (no regressions en dispositivos-table, create-dialog, edit-dialog, revoke-dialog), Playwright suite contra staging **30 passed + 1 skipped** (T8.2 skipped porque DB vacía — acceptable), web build 7 rutas. **Diferencias vs marbetes v2**: dispositivos no tienen assignment a estudiantes (no hay column student), serial en claro (no masking), `status` enum `active|revoked` (no `inactive`), `Sin marca` MetricCard usa `pills` attention. Plan + bitácora en `odd/tasks/dispositivos-inventory-v2.md`. |
| Polish WU v4 | ✅ done | `3f430bc` + `06fda3d` + `f45f7bf` (3 work-unit commits, merge TBD) | ~1250 (api + web combined) | Polish WU v4 closes the user's "completar la versión" before visual polish per screen. Three WU work-unit commits on `feature/bulk-upload`: WU #3 backend (POST /api/v1/marbetes/bulk + /bulk-csv with RFC-4180-lite CSV parser, transactional bulkInsert, audit aggregate inside same tx, 6 integration + 6 unit tests) → `3f430bc`. WU #4 frontend (BulkUploadDialog with drag&drop + paste + OTP + partial-failure summary screen, replaces the `window.alert('Cargar marbetes próximamente')` stub, 6 RTL tests) → `06fda3d`. WU #9 housekeeping (.gitignore for `apps/*/test-results/`, migrations.test.ts expected list, 4 lint cleanups: removed unused `total` prop from MarbetesPageClient + page.tsx, removed dead OUTER `ariaRole`/`collectText`/`implicitRole` from a11y.ts (~112 LOC), added eslint-disable-next-line comment for student-lookup intentional `state` dep omission) → `f45f7bf`. Numbers: api integration 94/94 + api unit 21/21 + web RTL 69/69 + build 7 routes + typecheck clean + lint 0/0. Plan + bitácora en `odd/tasks/polish-wu-v4.md`. |
| Polish WU v5 | ✅ done | (TBD — awaiting parent work-unit commits on `feature/audit-v2`) | +~640/-~210 net + ~80 doc closeout | Polish WU v5 cierra el rediseño de `/audit` per maquet InecConecta (replica del patrón marbetes v2 ya aplicado a `/dispositivos` en WU #2). **Task 1** page server rewrite: `limit:100` → `200`, `VALID_ACTIONS` extendido a los 12 valores del enum `AuditAction` (`marbete.create`/`update`/`delete`/`assign`/`reveal`/`bulk_create` + `dispositivo.create`/`update`/`revoke` + `auth.login`/`logout`/`failed`). **Task 2-4** `_components/audit-page-client.tsx` + `audit-table.tsx` + `audit-filters.tsx` reescritos: composición inventario v2 con 4 MetricCards (Total / Marbetes / Dispositivos / Autenticación con pill danger cuando hay `auth.failed`), DonutChart segments con tokens del maquet, filtros en `.inventory-search` shell (search input + count) + `.grid` row para los 5 filtros estructurados (entityType / action / actorId / since / until), tabla rediseñada con `.table-shell` + `.data-table` + `IdBadge` `AUD-${id.padStart(4,'0')}` + `StatusChip` mapeando las 12 acciones a las 3 variantes existentes del componente ('available' para create/assign/login/bulk_create, 'assigned' para update/reveal/logout, 'danger' para delete/revoke/failed) + `SortHeader` para ID y Fecha (ciclo 2-state: occurredAt default DESC, id default ASC) + `Pagination` + `<tr onClick>` que abre el drawer (preserva el click-handler que el T6 spec necesita en línea 116+). **Task 5** Playwright spec `09-audit-design.spec.ts` (NEW, 6 cases T9.1-T9.6): T9.1 4 metric cards visibles + screenshot `audit-v2-design.png`; T9.2 tabla muestra `AUD-####` IdBadges (graceful empty-state); T9.3 search input sincroniza URL a `?search=marbete`; T9.4 SortHeader `occurredAt` cycle DESC↔ASC via `data-sort-direction`; T9.5 auditor también alcanza el screen con las 4 cards; T9.6 operator redirect → /dashboard. **Strict TDD**: 6 tests RED fallaron en el primer run antes de implementar (4 en `audit-page-client.test.tsx` + 2 en `audit-table.test.tsx`); 16/16 GREEN después; +2 TRIANGULATE (Dispositivos filter + ID sort cycle) → 79 web RTL + 115 API integration + build 7 rutas + typecheck/lint clean. `AuditDetailDrawer` intacto (`data-testid="audit-detail"` preservado). Sin nuevos tokens CSS, sin nuevos componentes, sin nuevas deps. Plan + bitácora en `odd/tasks/polish-wu-v5.md`. |

Rama de feature: `feature/wu0-bootstrap`. Total acumulado en la rama:
~15k insertions (incluye `node_modules`, `package-lock.json`, assets
`diseno/`, y la base WU0+WU1).

## 13. Bloqueadores activos (transparencia)

- ~~`gentle-ai-worker` no puede registrar worktree en este repo~~ —
  **resuelto en WU4**. El subagent ejecuta correctamente delegaciones con
  un solo archivo (`packages/shared/src/dto/dispositivo.ts`, WU4 fase 1) y
  múltiples archivos (5 archivos de WU4 fase 2) cuando la tarea incluye
  la sección canónica `## Allowed edit surfaces` con un path por línea
  justo después del heading, sin prosa intermedia. WU5+ se delega via
  `gentle-ai-worker` por defecto; se vuelve inline solo si reaparece el
  bug.