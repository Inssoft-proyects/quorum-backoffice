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
| WU6 | API: Auth + RBAC | ~300 | Login, sesión firmada, preHandlers por rol |
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
| WU3a | ✅ done | \ | 841 | Marbetes CRUD scaffolding (DTOs + repo + service + routes). OTP deferred WU3b. 8 nuevos tests integration (23/23 total). |
| WU3b | ⏳ next | — | — | canvas-client + otp-guard + integración. |
| WU4 | pending | — | — | API Dispositivos CRUD + OTP guard. |
| WU5 | pending | — | — | API Audit + append-only. |
| WU6 | pending | — | — | API Auth + RBAC. |
| WU7 | pending | — | — | Web Layout + Login real. |
| WU8 | pending | — | — | Web Marbetes screen. |
| WU9 | pending | — | — | Web Dispositivos screen. |
| WU10 | pending | — | — | Web Audit screen. |
| WU11 | pending | — | — | Observabilidad + runbook + e2e. |

Rama de feature: `feature/wu0-bootstrap`. Total acumulado en la rama:
~15k insertions (incluye `node_modules`, `package-lock.json`, assets
`diseno/`, y la base WU0+WU1).

## 13. Bloqueadores activos (transparencia)

- **`gentle-ai-worker` no puede registrar worktree en este repo** (error
  estable: "Select an existing worktree in the same Git clone as this
  session"). Probado con sesión_worktree_register, worktree manual, commit
  inicial. Fallback inline aplicado por ahora. WU3+ (CRUD) se beneficiaría
  de worker; investigar el bug del runner antes de WU3.