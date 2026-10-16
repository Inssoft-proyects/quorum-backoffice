# Dispositivos assignment retirement (fase 2)

Feature: eliminar el vínculo dispositivo→alumno ya deprecado: dropear la columna `dispositivos.assigned_student_id`, retirar los endpoints `assign`/`unassign` de dispositivos y dar de baja `deny.device_not_bound_to_student`.
Repo: `quorum-backoffice` · Rama: `feat/mfa-shared-device-allowlist` · Estado: autorizado (2026-10-16, "Procede hasta terminar").

## Specs

Los `S#` citan textualmente al operador; no agregan requisitos no pedidos.

- **S1** — "es innecesario que exista el campo assigned_student_id, porque no lo asociaremos los dispositivos a los estudiantes".
- **S2** (fase 1, ya cumplida) — el dispositivo es lista blanca de equipos aprobados (`status='active' AND revoked_at IS NULL`), no factor de identidad; la identidad es marbete + OTP.

Contrato derivado (evidencia de código, no requisito nuevo):

- Migración nueva que **dropee** `dispositivos.assigned_student_id` y su índice `idx_dispositivos_assigned_student_id`.
- **NO tocar** `marbetes.assigned_student_id` (el FK marbete→alumno se conserva: es la identidad del marbete).
- **NO tocar** los valores de enum `audit_action` `dispositivo.assign`/`dispositivo.unassign` (Postgres no permite dropear valores de enum fácilmente y filas históricas pueden referenciarlos); solo se elimina el **código** que los emite.
- Retirar rutas `POST /api/v1/dispositivos/:id/assign` y `:id/unassign` + su esquema Zod.
- Retirar métodos `DispositivosService.assign`/`unassign` + helpers (`resolveCanvasStudent`, `snapshot` de asignación) + tipos `AssignDispositivoRequest`/`DispositivoAssignmentResponse` + las entradas `'dispositivo.assign'`/`'dispositivo.unassign'` de `DESTRUCTIVE_ACTIONS`.
- Retirar `PgDispositivoRepo.assignStudent` y la columna `assigned_student_id` de las consultas/tipos de `pg-dispositivos.ts`.
- Retirar `assigned_student_id` de `MfaDeviceRow` y del `SELECT` de `findDeviceBySerialNumber` en `pg-mfa-repo.ts` (el de `marbetes` se conserva).
- **CONSERVAR** `PgDispositivoRepo.findActiveOwnerBySerialAndCanvasId` (ya resuelve por `canvas_user_id`; lo usa `access-decision-service`).
- Dar de baja `deny.device_not_bound_to_student`: quitarlo de `MfaDeny` (union), de los DTO compartidos (`access-decision.ts`, `mfa.ts`) y del `DenyEnvelope` Zod en `swagger.ts`; barrer `apps/api/docs/openapi/mfa.openapi.yaml`.
- Actualizar tests y docs (RUNBOOK sección assign, mfa-flujos, fixtures de seed).

## Tasks

| ID | S# | Tarea | Ruta | Commit |
|----|----|-------|------|--------|
| T1 | S1 | Migración `0022_drop_device_assignment.sql`: `DROP INDEX IF EXISTS idx_dispositivos_assigned_student_id` + `ALTER TABLE dispositivos DROP COLUMN IF EXISTS assigned_student_id` | inline | work-unit |
| T2 | S1 | Rutas: quitar `assign`/`unassign` + `AssignDispositivoRequest` zod en `routes/dispositivos.ts` | inline | work-unit |
| T3 | S1 | Servicio: quitar `assign`/`unassign` + helpers + tipos + entradas `DESTRUCTIVE_ACTIONS` en `dispositivos-service.ts` | inline | work-unit |
| T4 | S1 | Repo dispositivos: quitar `assignStudent` + `assigned_student_id` de consultas/tipo en `pg-dispositivos.ts` | inline | work-unit |
| T5 | S1 | Repo MFA: quitar `assigned_student_id` de `MfaDeviceRow` + `SELECT` en `pg-mfa-repo.ts` | inline | work-unit |
| T6 | S1 | Retirar `deny.device_not_bound_to_student` de `MfaDeny` + DTOs + `DenyEnvelope` + barrer openapi | inline | work-unit |
| T7 | S1 | Tests: eliminar/actualizar `dispositivos-assign-routes.test.ts`, `device-assignment-service.test.ts` (unit+int), `access-decision-schema.test.ts`, fixtures de seed que referencian `assigned_student_id` | inline | work-unit |
| T8 | S1 | Docs: quitar sección assign de `RUNBOOK.md`, barrer `mfa-flujos.md`/openapi | inline | work-unit |
| T9 | S1 | Verificación (typecheck + unit + integración) + verificación independiente (alto riesgo: migración + contrato) | `gentle-ai-verify` | — |
| T10 | S1 | Commit de unidad de trabajo (Conventional Commit) | — | pendiente |

## Log

- **L1** (decisión, textual): "es innecesario que exista el campo assigned_student_id, porque no lo asociaremos los dispositivos a los estudiantes".
- **L2** (2026-10-16, autorización): "Procede hasta terminar" — sobre la fase 2 documentada en `odd/tasks/mfa-shared-device-allowlist.md` L7/L8.
- **L3** (2026-10-16, implementación + verificación): fase 2 implementada (worker `gentle-ai-worker` + follow-up inline de prosa). Typecheck shared+api 0 errores; unit 331/331 (23 suites), integración 220/220 (18 suites). El typecheck de `apps/web` reporta 2 errores **PRE-EXISTENTES** y ajenos a esta fase (`sisId` faltante en `test/unit/edit-dialog.test.tsx` y `test/unit/marbetes-table.test.tsx`, derivados de `0020_students_sis_id.sql`). Se retiró `deny.device_not_bound_to_student` (taxonomía 11→10) y se barrió `mfa-form.tsx` + `mfa-get-subject.ts` (prosa/caso de switch muerto).
