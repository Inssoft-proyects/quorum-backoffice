# Quorum Backoffice — Polish WU v1

> Feature ODD para cerrar 4 polish items pendientes del MVP (HANDOFF §"Polish
> items pendientes"). Scope acordado: **1, 2, 3, 4**. Items 5 (bcrypt→argon2id)
> y 6 (audit_log archival) quedan como Polish WU futuros.

## 1. Identidad

| Campo | Valor |
| --- | --- |
| Feature | `polish-wu-v1` |
| Suite | Quorum (sigue `quorum-backoffice-mvp` ya cerrado) |
| Estado | branch `feature/wu0-bootstrap`, HEAD `4da0bb2` |
| Rama | se commitea en `feature/wu0-bootstrap` (sin crear rama nueva) |
| Review budget | ≤400 líneas modificadas por WU (acumulado ≤400 para los 4 tasks) |
| Tests | Sin tests nuevos (los 4 items son infra/devops, no lógica de negocio) |
| Quality gates | `npm test`, `npm run typecheck` (api+web), `npm run lint`, `apps/web npm run build` |

## 2. Objetivo

Cerrar los polish items 1–4 del HANDOFF sin tocar lógica de negocio ni romper
los 148/148 tests verdes.

- **Task 1 — dist path fix:** `apps/api/package.json` `main` y `start` apuntan
  a `dist/server.js`, pero `tsc` emite a `dist/src/server.js`. El systemd unit
  ya tiene el path correcto pero `npm start` falla. Fix: 2 strings.
- **Task 2 — infra/systemd/ como archivos:** los 2 unit templates viven inline
  en `infra/nginx/README.md` §5. Extraerlos a `infra/systemd/*.service` como
  archivos committed + actualizar README para referenciarlos en lugar de
  embebidos.
- **Task 3 — ESLint flat config para apps/web:** `next lint` fue removido en
  Next.js 16; el lint script actual es un placeholder `tsc --noEmit`. Crear
  `apps/web/eslint.config.js` flat config usando `eslint-config-next` (ya
  instalado) y restaurar el script lint real.
- **Task 4 — Playwright e2e seed script:** los 7 tests e2e requieren usuarios
  seed (admin/operator/auditor con hashes bcrypt). Crear script idempotente
  `apps/api/scripts/seed-e2e-users.ts` + documentar el flujo en RUNBOOK.md.

## 3. Convenciones heredadas

- Conventional Commits (`type(scope): summary`).
- `quorum-dev <quorum@local>` para los commits del worker (consistente con WUs previos).
- Allowed edit surfaces explícitos (ver delegación al worker).
- Sin cambios a schema, sin breaking changes al contrato API.
- No tocar `apps/web/e2e/*.spec.ts` (los tests authored quedan como están).

## 4. Work Units (tareas)

| # | Task | Concern | Est. líneas | Archivos tocados |
| --- | --- | --- | --- | --- |
| 1 | dist path fix | api package.json | ~3 | `apps/api/package.json` |
| 2 | systemd files | infra/systemd | ~110 | `infra/systemd/quorum-backoffice-api.service` (NEW), `infra/systemd/quorum-backoffice-web.service` (NEW), `infra/nginx/README.md` (referencia) |
| 3 | ESLint flat config | apps/web lint | ~40 | `apps/web/eslint.config.js` (NEW), `apps/web/package.json` (lint script) |
| 4 | Playwright e2e seed | dev tooling | ~120 | `apps/api/scripts/seed-e2e-users.ts` (NEW), `RUNBOOK.md` (E2E setup) |

**Total estimado**: ~270 líneas modificadas, dentro del budget de 400.

## 5. Definition of Done

- 4 commits work-unit en `feature/wu0-bootstrap`, mensajes Conventional.
- `cd apps/api && npm run typecheck` verde.
- `cd apps/web && npm run typecheck && npm run lint` verde (lint ahora usa ESLint real).
- `npm test` (root) verde — 148/148 sin regresiones.
- `cd apps/web && npm run build` verde.
- `apps/api` puede arrancar con `npm start` (verificación manual o por test).
- README de nginx actualizado para apuntar a los archivos committed, no inline.
- RUNBOOK.md actualizado con flujo de seed e2e.
- Bitácora §12 actualizada en `odd/tasks/quorum-backoffice-mvp.md` con los 4 commits.

## 6. Riesgos y mitigaciones

1. **Task 3 — ESLint flat config puede ser ruidoso.** Mitigación: empezar con
   config mínima que solo extienda `next/core-web-vitals` y `next/typescript`,
   no aspirar a zero-warnings en la primera pasada (los warnings pre-existentes
   no son regresión).
2. **Task 4 — Seed script toca DB real.** Mitigación: usar DB `quorum_backoffice_test`
   (nunca `quorum_backoffice`), idempotencia via UPSERT (ON CONFLICT DO NOTHING),
   passwords aleatorios por defecto con override por env vars, log explícito
   de lo que se creó.
3. **Task 2 — Cambio a README puede romper formato markdown.** Mitigación:
   diff pequeño, enfocado a reemplazar los bloques inline por referencias.

## 7. Out of scope (este WU)

- Item 5: bcrypt → argon2id (security migration, WU futuro).
- Item 6: audit_log archival policy (schema + cron, WU futuro).
- Nuevos tests e2e (los 7 authored son suficientes para verificar el seed).
- Cambios a la lógica de auth, marbetes, dispositivos, audit, RBAC.

## 8. Próximo paso

Delegar a `gentle-ai-worker` con allowed edit surfaces explícitos:
- `apps/api/package.json`
- `infra/systemd/quorum-backoffice-api.service` (NEW)
- `infra/systemd/quorum-backoffice-web.service` (NEW)
- `infra/nginx/README.md`
- `apps/web/eslint.config.js` (NEW)
- `apps/web/package.json`
- `apps/api/scripts/seed-e2e-users.ts` (NEW)
- `RUNBOOK.md`

4 commits esperados, en orden de task #.
