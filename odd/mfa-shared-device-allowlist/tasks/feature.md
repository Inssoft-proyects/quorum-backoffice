# MFA shared-device allowlist — mirror

Espejo de `odd/tasks/mfa-shared-device-allowlist.md`. La fuente de verdad es ese documento.

## Estado

- Rama: `main` (repo `quorum-backoffice`, git anidado).
- Fase 1 (corrección, reversible, sin migración): T1–T7.
- Fase 2 (limpieza, separada y gated): eliminar columna `dispositivos.assigned_student_id`, retirar endpoints `assign`/`unassign` de dispositivos y dar de baja `deny.device_not_bound_to_student`.

## Tasks (fase 1)

- T1 `mfa-get-subject-service.ts` → device `status='active' AND revoked_at IS NULL`.
- T2 `mfa-authenticate-service.ts` → mismo cambio (paso 4).
- T3 `access-decision-service.ts` + `pg-dispositivos.ts` → `isApprovedDevice(serial)` reemplaza JOIN owner.
- T4 Tests unit + integración (RED→GREEN): activo+no asignado allow; revocado/desconocido `deny.device_unknown`; OTP sigue ligado a `canvas_user_id`.
- T5 Docs + OpenAPI: deprecar `deny.device_not_bound_to_student`, nota columna ignorada, `mfa-flujos.md` + `RUNBOOK.md`.
- T6 Verificación independiente (`gentle-ai-verify`).
- T7 Commit de unidad de trabajo (Conventional Commit).

## Decisiones clave

- Pool único compartido (Interpretación A). Separación por salón = feature aparte.
- `marbetes.assigned_student_id` se CONSERVA (identidad del marbete).
- `dispositivos.assigned_student_id` se ignora en fase 1; no se elimina aún.
