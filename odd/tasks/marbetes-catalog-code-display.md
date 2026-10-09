# Marbetes catalog: store the code and mask it for display

## Goal

The `/backoffice/marbetes` catalog must show exactly the 10 real marbetes
(`VALIDO-2609982468` … `VALIDO-2609982477`), display each masked as `V***68`
(first char + `***` + last 2), and store the full code instead of only a hash.

## Context / Root cause

- The marbetes table stored only `code_hash = sha256(code)` plus a generated
  `public_uid = m-<6 hex of hash>`. The plaintext code was never stored, so the
  catalog could not mask it and instead rendered `m***1a`.
- A previous synthetic-data load (2026-10-06) inserted 10 `VALIDO-*` marbetes
  with `m-*` public_uids, plus 10 obsolete `CRD-*` marbetes from 2023–2024.
  The catalog therefore showed 20 rows (wrong), with the synthetic ones first
  (ordered by created_at DESC).

## Decisions (operator-approved)

1. Masked display format: `V***68` (first char + `***` + last 2 chars).
2. Store the full marbete code (not a hash) as the operator-facing number.

## Changes

### Data remediation (production `quorum_backoffice`)

- Backup: `marbetes_backup_20261009` (20 rows).
- Deleted the 10 obsolete `CRD-*` rows.
- Set `public_uid = VALIDO-2609982468…2477` for the 10 real rows (matched by
  `code_hash`).

### Code (branch `fix/quorum-ecosystem-remediation-p2`)

- `apps/api/src/services/marbetes-service.ts`: `create`/`bulkCreate` now store
  `req.code` as `public_uid` (the marbete number) instead of `generatePublicUid()`.
  `code_hash` is kept as an internal index for the MFA `code_hash` lookup.
- `apps/web/components/inventory/add-marbete-dialog.tsx`: accepts alphanumeric
  codes (`VALIDO-…`) instead of digits-only.
- `packages/shared/src/dto/marbete.ts`: doc comments updated.

## Verification

- Typecheck `apps/api` + `packages/shared`: clean.
- Unit tests: API marbetes (20) + web marbetes (26) green.
- DB catalog: 10 rows, masked `V***68` … `V***77`.

## Remaining

- Deploy the API + web change to `/opt/quorum-backoffice` and restart the pods
  (production mutation; pending operator go-ahead).
- Follow-up (optional): drop the internal `code_hash` once MFA no longer depends
  on it; decide cleanup of the synthetic students/devices.
