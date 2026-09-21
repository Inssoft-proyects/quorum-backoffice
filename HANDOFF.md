# Handoff — Quorum Backoffice MVP (continuación)

Pega este bloque en una sesión nueva de Pi para retomar el trabajo.

---

# Rol y contexto

Estoy construyendo el sistema **Quorum Backoffice** — un nuevo servicio del
suite Quorum que gestiona la seguridad física de acceso (marbetes QR
lenticular, dispositivos autorizados, audit log con OTP). Es el primer
consumidor de **shadcn/ui** del suite; el resto son Fastify 5 + vanilla TS.

# Workspace

- Repositorio: `/planQuorum/dev/quorum-backoffice` (cwd obligatorio en la
  nueva sesión)
- Rama activa: `feature/wu0-bootstrap` (trackea `origin/feature/wu0-bootstrap`)
- Plan ODD (fuente de verdad): `odd/tasks/quorum-backoffice-mvp.md`
- Brief de diseño: `./diseno/image.png` (tokens + iconos, **NO** wireframes)
- Repos hermanos: `/planQuorum/dev/quorum-otp` (servicio OTP),
  `/planQuorum/dev/quorum-backend` (portal-api + Canvas LTI)

# Stack convenciones (respetar)

- **Monorepo** npm workspaces (no pnpm): `apps/api`, `apps/web`,
  `packages/shared`
- **Backend**: Node 22 + TypeScript 5 + Fastify 5 + PostgreSQL 18 +
  Redis 8 + Zod + Pino + prom-client. Sin Docker local (PG + Redis
  instalados vía `scripts/dev-bootstrap.sh`)
- **Frontend**: Next.js 15 App Router + React 19 + TypeScript 5 +
  Tailwind 4 + shadcn/ui (Radix + CVA) + lucide-react
- **Shared**: Zod DTOs en `packages/shared/src/dto/<entity>.ts`; el api
  consume desde `dist/`
- **Strict TDD**: tests RED → GREEN → REFACTOR. Cobertura ≥80% líneas.
  Tests integración contra PG/Redis reales (sin mocks de DB).
- **Audit log**: append-only enforced via `REVOKE UPDATE,DELETE,TRUNCATE
  FROM PUBLIC` en la migration.
- **OTP**: cada operación destructiva requiere header `X-OTP-Code`; el
  service llama `OtpClient.verify({subject,scope,code})` y escribe
  `audit_log` con el `otp_id` resultante.
- **Review budget**: ≤400 líneas por WU; los WU3a y WU3b lo excedieron
  legítimamente (scope justificado).

# Estado al cierre

| WU | Estado | Commit | LOC |
| --- | --- | --- | --- |
| WU0 | ✅ done | `1f6fd95` | bootstrap monorepo |
| WU1a | ✅ done | `f5d1adc` | design tokens + 5 shadcn core |
| WU1b | ✅ done | `73a5011` | shadcn extend + dark mode |
| WU2 | ✅ done | `ef998be` | schema + 4 migrations + audit inmutable |
| WU3a | ✅ done | `27c34c9` | marbetes CRUD scaffolding |
| WU3b | ✅ done | `771a55e` | OTP + audit + canvas/otp clients |
| **WU4** | **⏳ SIGUIENTE** | — | API Dispositivos CRUD |
| WU5 | pending | — | API Audit (read-only) |
| WU6 | pending | — | API Auth + RBAC |
| WU7 | pending | — | Web Layout + Login real |
| WU8-10 | pending | — | Web screens (marbetes, dispositivos, audit) |
| WU11 | pending | — | Observabilidad + e2e |

**Tests**: `22/22` pasando. **Push**: rama ya en GitHub
(`https://github.com/Inssoft-proyects/quorum-backoffice`).

# Verificación al iniciar nueva sesión

```bash
cd /planQuorum/dev/quorum-backoffice
git status                  # debe estar clean en feature/wu0-bootstrap
git log --oneline | head 5  # debe terminar en a835b9f
npm install                 # 757 paquetes
npm test                    # 22/22 verde
npm run typecheck           # 0 errores
npm run lint                # 0 warnings
cd apps/web && npm run build  # OK
```

Si Redis o PG no están vivos, ejecutar antes:
```bash
bash scripts/dev-bootstrap.sh
```

# Patrones establecidos (replicar en WU4+)

- **Repository** en `apps/api/src/repositories/<entity>.ts`:
  `pg.Pool` inyectado; queries parametrizadas; `toResponse()` row → DTO
- **Service** en `apps/api/src/services/<entity>-service.ts`: business
  logic + OTP guard + audit emission. Inyecta `OtpClient` + `pool` +
  `FastifyBaseLogger`.
- **Routes** en `apps/api/src/routes/<entity>.ts`: thin — validan Zod,
  llaman service, devuelven envelope.
- **DTOs Zod** en `packages/shared/src/dto/<entity>.ts`: shared entre api
  y web. Rebuild shared tras cambios: `cd packages/shared && npm run build`
- **Tests integration**: usan `app.inject()` de Fastify; mockean OTP y
  Canvas con `globalThis.fetch` reemplazado. Migraciones se corren en
  `beforeAll` desde `src/migrations.ts`.
- **bigint** en PG: el plugin pg.ts ya tiene `pg.types.setTypeParser(20,
  parseInt)` — no tocar.
- **fetch lazy**: `OtpClient` y `CanvasClient` usan
  `globalThis.fetch` por defecto para permitir mock; si necesitas pasar
  uno custom, hazlo via el constructor.
- **Audit writes**: usar `AuditService(pool).write({actorId, action,
  entityType, entityId, beforeJson, afterJson, otpId, ip, userAgent})`.

# Bloqueador activo (transparencia)

`gentle-ai-worker` no puede registrar worktree en este repo — error
estable: `"could not register launched worktree: Select an existing
worktree in the same Git clone as this session"`. Probado con
`session_worktree_register`, worktree manual, commit inicial; el runner
rechaza igual. **Fallback inline aplicado** para los 6 WUs ya entregados.
Antes de WU4+ decide si:
- Continuar inline (como hasta ahora)
- Investigar el bug del runner (probablemente config de la extensión
  `pi-subagents`)
- Otra estrategia

# Próximo paso concreto — WU4 (API Dispositivos)

Scope (~300 LOC, 4-6 tests):

1. **DTOs** en `packages/shared/src/dto/dispositivo.ts`:
   `CreateDispositivoRequest`, `UpdateDispositivoRequest`,
   `ListDispositivosFilter`, `DispositivoResponse`,
   `DispositivoDetailResponse`, `ListDispositivosResponse`
2. **Repository** `apps/api/src/repositories/pg-dispositivos.ts`:
   `findById`, `list` (con filter status + search), `insert`,
   `setStatus(id, 'revoked', reason)`, `update(brand, model)`, `toResponse`
3. **Service** `apps/api/src/services/dispositivos-service.ts`: reusar
   el patrón exacto de `marbetes-service.ts` (OtpClient + AuditService).
   Action labels: `dispositivo.create`, `dispositivo.update`,
   `dispositivo.revoke`. Soft-revoke con `revoked_at` + `revoked_reason`.
4. **Routes** `apps/api/src/routes/dispositivos.ts`: 5 endpoints
   (list, get, create, patch, delete) con OTP enforcement.
5. **Registrar** en `apps/api/src/app.ts`.
6. **Tests** `apps/api/test/integration/dispositivos.test.ts`:
   happy path con mock OTP + audit, rejection paths.
7. **Commit** con Conventional Commits: `feat(dispositivos): API CRUD + OTP guard (WU4)`

# Recordatorios finales

- **No commitear** sin que el usuario lo pida explícitamente.
- **No pushear** sin que el usuario lo pida.
- **No merge** a master sin PR review.
- Si descubres un WU que excede 400 LOC, splitealo (WU3a/WU3b es la
  prueba del patrón).
- Actualiza `odd/tasks/quorum-backoffice-mvp.md` §12 (bitácora) en cada
  WU cerrada.
- Marca `## Allowed edit surfaces` antes de delegar a worker (cuando
  funcione); pero mientras esté bloqueado, hazlo inline.
