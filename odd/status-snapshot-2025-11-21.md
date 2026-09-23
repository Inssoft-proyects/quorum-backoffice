# Quorum Backoffice MVP — Status Snapshot

**Fecha**: 2025-11-21
**Rama**: `feature/wu0-bootstrap`
**Último commit**: `2c0878b docs(plan): record WU9 commit hash c826bce in feature log §12`

---

## Resumen ejecutivo

- **Backend API**: ✅ **completo al 100%** (todas las rutas implementadas + tests + RBAC)
- **Web app**: ⏳ **80% completo** (faltan audit screen y e2e)
- **Calidad**: ✅ typecheck + lint + build limpios
- **Tests**: ✅ **138/138 verde** (85 API + 53 web), 0 fallando, 0 skipped

---

## Estado por Work Unit

| WU | Concern | Estado | Commit | LOC | Tests |
| --- | --- | --- | --- | --- | --- |
| WU0 | Bootstrap monorepo | ✅ done | `1f6fd95` | ~440 | 6/6 |
| WU1a | Tokens + shadcn core | ✅ done | `f5d1adc` | 443 | — |
| WU1b | shadcn extend + theme | ✅ done | `73a5011` | 1322 | — |
| WU2 | Schema + 4 migrations + audit inmutability | ✅ done | `ef998be` | 427 | 11 |
| WU3a | Marbetes API CRUD scaffolding | ✅ done | `27c34c9` | 841 | 23/23 |
| WU3b | OTP guard + audit emission | ✅ done | `771a55e` | 570 | 22/22 |
| WU4 | Dispositivos API CRUD | ✅ done | `c8fa1b8` | 809 | 33/33 |
| WU5 | Audit API read-only | ✅ done | `1c2902c` | 511 | 44/44 |
| WU6a | Auth core (login/logout/me) | ✅ done | `ee1f589` | 1019 | 56/56 |
| WU6b | Session plugin + RBAC + wire | ✅ done | `9a641ab` | 619 | 72/72 |
| WU7 | Web layout + login real | ✅ done | `5791ac8` | ~720 | 88/88 |
| WU8a | Web Marbetes list/delete | ✅ done | `eb77c8e` | 692 | 100/100 |
| WU8b1 | canvasUserId + students endpoint | ✅ done | `40a3cdd` | 582 | 113/113 |
| WU8b2 | Web Marbetes create/edit | ✅ done | `a74687d` | 957 | 122/122 |
| WU9 | Web Dispositivos CRUD | ✅ done | `c826bce` | ~960 | 138/138 |
| **WU10** | **Web Audit screen** | **⏳ SIGUIENTE** | — | — | — |
| WU11 | Observabilidad + runbook + e2e (Playwright) | pending | — | — | — |

---

## Estado por sección

### Backend API (apps/api)

| Concern | Estado | Detalle |
| --- | --- | --- |
| **Schema + migrations** | ✅ 100% | 6 migrations: init / marbetes / dispositivos / audit / auth / students_active. Audit log enforced `REVOKE UPDATE,DELETE,TRUNCATE FROM PUBLIC` en `information_schema.role_table_grants` (PG18-compatible verified). |
| **Marbetes CRUD** | ✅ 100% | 6 endpoints (list / counters / get / create / patch / delete) con OTP guard. assign via `canvasUserId` (resolución + 422 inactive/invalid). |
| **Dispositivos CRUD** | ✅ 100% | 5 endpoints con OTP guard. Soft-revoke (status='revoked' + revoked_at + revoked_reason). |
| **Audit read-only** | ✅ 100% | 2 endpoints (list+detail) con filtros entityType / entityId / actorId / action / since / until / search. |
| **Auth + RBAC** | ✅ 100% | bcrypt cost-12 + Redis INCR rate limit (5/15min) + session tokens (32B base64url) + `requireSession` / `requireRole` preHandlers. Audit emissions para login/logout/failed. |
| **Students lookup** | ✅ 100% | GET `/api/v1/students?canvasUserId=X` (admin-only) con isActive flag. |
| **Test coverage** | ✅ 85/85 integration tests, 9 suites | |

### Web App (apps/web, Next.js 15 App Router)

| Concern | Estado | Detalle |
| --- | --- | --- |
| **Foundation (WU7)** | ✅ 100% | RTL + jest infra, api-client (login/logout/me + ApiError), server-session via `next/headers`, AuthContext, login page con server-side guard, (authed) route group, AppShell + Sidebar (RBAC) + Topbar, dashboard. |
| **Marbetes screen (WU8a/b1/b2)** | ✅ 100% | Status cards OK/KO, table con filtros status+search, delete dialog con razón+OTP, create/edit dialogs con StudentLookup on-blur canvas_user_id resolution. Masked code. |
| **Dispositivos screen (WU9)** | ✅ 100% | Table con serial completo + filtros, Edit/Revoke admin-gated, Revoke soft-revoke con razón+OTP, Create con conflict handling (serial único). |
| **Audit screen** | ⏳ PENDIENTE (WU10) | Filtros múltiples (entityType/actorId/action/since-until/search), drawer de detalle con before/after JSON + OTP metadata, role-gated auditor+. |
| **Test coverage** | ✅ 53/53 web tests, 16 suites | |

### Shared (packages/shared)

| Concern | Estado | Detalle |
| --- | --- | --- |
| **DTOs** | ✅ 100% | 5 DTO files (marbete, dispositivo, audit, canvas, otp, auth). Enums + Zod schemas + interfaces para respuestas. |
| **RBAC helpers** | ✅ 100% | `UserRole` + `ROLE_HIERARCHY` + `hasAtLeastRole`. |

### DevOps / Calidad

| Concern | Estado | Detalle |
| --- | --- | --- |
| **Git workflow** | ✅ 100% | Conventional Commits + commits pusheados a `origin/feature/wu0-bootstrap`. 31 commits totales. |
| **TypeScript strict** | ✅ 100% | `tsc --noEmit` clean en api + shared + web. |
| **Lint** | ✅ 100% | ESLint clean en api + web. |
| **Build** | ✅ 100% | Next.js build success, 7 rutas registradas (`/`, `/login` static; `/dashboard`, `/marbetes`, `/dispositivos`, `/audit` dynamic). |
| **Bitácora** | ✅ 100% | Plan §12 con hash + LOC por cada WU cerrado. |

---

## Líneas de código (rough)

- `apps/api/src`: ~2148 LOC
- `apps/web/app`: ~467 LOC (pages)
- `apps/web/lib`: ~1002 LOC (api-client, server-session, auth-context)
- `apps/web/components`: ~991 LOC (ui + layout)
- `apps/web/test`: ~339 LOC
- `packages/shared/src`: ~?

---

## Convenciones heredadas

- **Monorepo** npm workspaces (no pnpm): `apps/api`, `apps/web`, `packages/shared`
- **Backend**: Node 22 + TypeScript 5 + Fastify 5 + PG 18 + Redis 8 + Zod + Pino + prom-client
- **Frontend**: Next.js 15 App Router + React 19 + TypeScript 5 + Tailwind 4 + shadcn/ui + lucide-react
- **Shared**: Zod DTOs en `packages/shared/src/dto/<entity>.ts`; el api consume desde `dist/`
- **Strict TDD**: tests RED → GREEN → REFACTOR. Cobertura ≥80% líneas. Tests integración contra PG/Redis reales.
- **Audit log**: append-only enforced via `REVOKE UPDATE,DELETE,TRUNCATE FROM PUBLIC` en la migration.
- **OTP**: cada operación destructiva requiere header `X-OTP-Code`; el service llama `OtpClient.verify({subject,scope,code})`.
- **Puertos**: DEV 3xx (api 3100, web 3002), PROD 4xx (api 4100).
- **Review budget**: ≤400 líneas por WU; algunos WU lo exceden legítimamente.

---

## Próximos pasos

| WU | Scope | Est. LOC |
| --- | --- | --- |
| **WU10** | Audit screen con filtros + drawer detalle | ~350 |
| **WU11** | Observabilidad (`/metrics` ya existe, falta `/readyz` deep) + runbook + Playwright e2e | ~200–300 |
