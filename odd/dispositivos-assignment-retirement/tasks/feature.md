# Dispositivos assignment retirement — mirror

Espejo de `odd/tasks/dispositivos-assignment-retirement.md` (fuente de verdad).

## Fase 2 — limpieza del binding deprecado

- **Droppear**: `dispositivos.assigned_student_id` + índice `idx_dispositivos_assigned_student_id` (migración nueva `0022`).
- **CONSERVAR**: `marbetes.assigned_student_id` (FK identidad del marbete), `findActiveOwnerBySerialAndCanvasId` (lo usa access-decision), valores enum `audit_action` `dispositivo.assign`/`dispositivo.unassign`.
- **Retirar**: rutas/`service`/`repo` de assign/unassign; `deny.device_not_bound_to_student` de `MfaDeny` + DTOs + `DenyEnvelope` + openapi.

## Tasks T1–T10

T1 migración · T2 rutas · T3 servicio · T4 repo dispositivos · T5 repo MFA · T6 deny taxonomy · T7 tests · T8 docs · T9 verificación · T10 commit.
