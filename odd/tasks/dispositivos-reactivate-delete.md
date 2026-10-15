# Dispositivos: logical delete + re-registration by reactivation

## Goal
Allow a revoked ("logically deleted") device to be re-registered and/or
un-revoked **without ever deleting the row**, so `audit_log` references
(`entity_id`) never dangle and the physical device keeps one stable identity
across its whole lifecycle. Today a revoked device is a dead end: `DELETE` only
soft-revokes, `PATCH` rejects revoked rows, there is no reactivate path, and the
`serial_number` UNIQUE constraint turns any re-registration attempt into a 409.

## Design (logical-delete model — agreed direction)
- **No hard delete.** The existing soft-revoke (`DELETE` → `status='revoked'`)
  already IS the logical delete. Nothing is ever removed from `dispositivos`.
- **Re-registration = reactivation.** When `POST /api/v1/dispositivos` receives
  a serial that already exists in `revoked` state, it updates that same row back
  to `active` (and refreshes `brand`/`model`) instead of inserting a new row or
  returning 409. A serial that exists in `active` state still returns 409.
- **Explicit un-revoke.** `POST /api/v1/dispositivos/:id/reactivate` flips a
  revoked row back to `active` (no metadata change).

This keeps a 1:1 mapping between `serial_number` and one physical device, so
audit history is never truncated and re-registration is idempotent.

## Evidence / current state
- `DELETE /api/v1/dispositivos/:id` → `DispositivosService.revoke` (soft-revoke:
  `status='revoked'`, `revoked_at=now()`, `revoked_reason`).
- `PATCH` → `update` throws `409 cannot update a revoked dispositivo`.
- `PgDispositivoRepo.softRevoke` guards `WHERE id=$1 AND status='active'`.
- `dispositivos.serial_number` is `NOT NULL UNIQUE` (migration `0003`).
- `DispositivosTable` shows actions only when `status === 'active'`.
- `audit_action` is a PostgreSQL enum; new labels are added via single-statement
  `ALTER TYPE ... ADD VALUE IF NOT EXISTS` migrations (pattern `0008`/`0016`).
  The shared `AuditAction` z.enum must match the SQL labels byte-for-byte.

## Tasks

1. **Shared DTO** (`packages/shared/src/dto/dispositivo.ts`)
   - Add `ReactivateDispositivoRequest` (optional `reason`, 3..500) if a
     justification is wanted for the audit row.

2. **Audit action label**
   - `packages/shared/src/dto/audit.ts`: add `'dispositivo.reactivate'` to the
     `AuditAction` z.enum.
   - Migration `apps/api/migrations/0021_audit_action_device_reactivate.sql`
     (one `ALTER TYPE audit_action ADD VALUE IF NOT EXISTS
     'dispositivo.reactivate'`), applied before the service writes the action.

3. **Repository** (`apps/api/src/repositories/pg-dispositivos.ts`)
   - `findBySerialNumber(serial)`: single-row lookup by `serial_number`.
   - `reactivate(id, { brand?, model? })`:
     `UPDATE dispositivos SET status='active', revoked_at=NULL,
     revoked_reason=NULL, brand=COALESCE($2,brand), model=COALESCE($3,model)
     WHERE id=$1 AND status='revoked' RETURNING ...`.

4. **Service** (`apps/api/src/services/dispositivos-service.ts`)
   - Add `'dispositivo.reactivate'` to `DESTRUCTIVE_ACTIONS`.
   - `reactivate(actor, id, req?, otpCode, meta)`: OTP → 404 unknown → 409 if
     already `active` → before/after audit `dispositivo.reactivate`.
   - `create(...)`: after OTP, `findBySerialNumber`; if exists + `active` →
     409; if exists + `revoked` → `reactivate` + audit `dispositivo.reactivate`;
     otherwise insert + audit `dispositivo.create` (unchanged).

5. **Routes** (`apps/api/src/routes/dispositivos.ts`)
   - `POST /api/v1/dispositivos/:id/reactivate` (`requireRole('admin')`, OTP).

6. **Web API client** (`apps/web/lib/api-client.ts`)
   - `reactivateDispositivo(id, otpCode, cookie?)`.
   - (`createDispositivo` already exists; its happy path now also reactivates a
     revoked serial.)

7. **Table** (`apps/web/app/(authed)/dispositivos/_components/dispositivos-table.tsx`)
   - For `status === 'revoked'` rows (admin only), render a "Reactivar" action.

8. **Dialog + page client**
   - New `ReactivateDialog` (confirmation + OTP).
   - Wire `toReactivate` state + refresh in `dispositivos-page-client.tsx`.

9. **Tests**
   - API integration: reactivate happy path + 404 + 409 already-active + OTP
     required/invalid + audit row; create-with-revoked-serial reactivates (same
     `id`, serial stays, status active, brand/model updated) + create-with-active
     serial still 409; audit `dispositivo.reactivate` emitted.
   - Web unit tests for the new action/dialog.

## Decisions (locked)
1. **State model** — reuse `'revoked'` as the logical delete. No new enum label,
   no hard delete. "Revocar" and "eliminar" are the same soft-delete.
2. **Assignment on reactivation** — `assigned_student_id` is NOT touched (the
   Dispositivos UI has no device→student binding; that is a separate S2S
   concern). Reactivation only flips `status`/`revoked_at`/`revoked_reason`
   (+ `brand`/`model` on the create-upsert).
3. **`created_at` / `created_by`** — preserved (first-registration identity).
   The reactivation timestamp lives in `audit_log`.
4. **Audit naming** — new action `'dispositivo.reactivate'` (migration `0021`)
   for both the explicit un-revoke and the create-upsert.

## Implementation status
- API: `reactivate` repo/service/route + create-upsert; shared `AuditAction` +
  migration `0021`; integration tests `dispositivos-reactivate.test.ts`.
- Web: `ReactivateDialog`, `Reactivar` action on revoked rows, api-client
  `reactivateDispositivo`, page-client wiring, table unit tests.
- Verified: shared build clean; API typecheck clean; web typecheck clean;
  API unit 328/328; web unit 233/233; integration (reactivate + migrations +
  dispositivos CRUD/assign) 66/66.
