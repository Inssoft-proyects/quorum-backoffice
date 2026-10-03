# Canvas-bound device authorization

## Goal
Implement the approved Backoffice prerequisite for federated Canvas/Jitsi access: each approved device has at most one Canvas user owner; only an active device assigned to an active student may satisfy a security access decision. Multiple devices per student may be allowed; an unassigned device is inventory only, not access permission. This work unit never grants entry to Canvas or Jitsi.

## Context and constraints
- Parent feature: `../quorum-canvas/odd/tasks/canvas-jitsi-federated-access.md` (independent repository); approved institutional enrollment/display name is Canvas SIS User ID, not the internal Canvas user ID.
- Preserve Backoffice marbete binding (`students_cache`); current `dispositivos` has no owner FK. Prior `odd/tasks/dispositivos-inventory-v2.md` recorded intentionally unassigned inventory; user has explicitly superseded that decision for access authorization only.
- Work in isolated linked worktree `feat/canvas-jitsi-device-binding` from `master`, not the existing dirty `feature/marbetes-v3-asignacion` checkout. No live migration/apply or production account changes. No push/PR.
- Revoked/unassigned devices and inactive/missing students must never be accepted. Brand/model/serial are inventory claims, not proof of enrollment or device possession. Never expose serials in auth denial logs.
- Preserve data on migrations; do not invent assignments for existing devices. Admin assignment/reassignment will need OTP + audit in a distinct bounded work unit. No public read/decision endpoint before machine authentication is implemented.

## Tasks
- [x] B1 Add nullable device-to-student FK and repository read model with fail-closed ownership lookup; deterministic unit/integration RED (missing column/method), then GREEN: 5 unit + 8 device integration + 10 migration + 6 student integration = 29/29 passing on local test DB. No production migration. Existing devices stay NULL; `ON DELETE SET NULL` observed in rolled-back test. Work-unit commit recorded below.
- [ ] B2 Add audited admin-only assignment/unassignment through existing device service/route with OTP, tests for unauthorized and reassignment; preserve existing CRUD. Commit with behavior/tests and operator docs.
- [ ] B3 Define authenticated service-to-service access-decision API and true Canvas SIS lookup contract (not implementation of IdP or Jitsi); only after scopes and sources are validated. Commit with tests/docs; no live deployment.
- [ ] B4 Track unrelated baseline checks until fixed by their owning work unit: `apps/api` typecheck currently fails at `src/services/marbetes-service.ts:300,318` (`BulkCreateMarbeteFailure.category`); this predates B1 and no B1 path has a type error. Existing `test:integration` script uses removed Jest `--testPathPattern` flag; focused tests were run directly with `--testPathPatterns`. Do not modify unrelated Marbetes feature in this worktree.

## Verification and status
B1 complete on isolated test database: 29/29 focused tests pass, including negative ownership and migration idempotency. Parent feature T3 remains blocked on safe staging secrets/TLS; no Canvas login or production DB has been changed. API typecheck still has two pre-existing Marbetes errors (B4), and full suites/builds have not run. Next B2 audited admin-only assignment; no access-decision route is exposed.
