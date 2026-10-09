# MFA reconcile into master

## Goal

Reconcile the MFA surface (student authentication by marbete + device + OTP)
into `master` so `master` becomes a complete, compilable git backup of the MFA
surface deployed in production (`/opt/quorum-backoffice`, migrations 0011–0020),
without touching `quorum-otp` and without renumbering migrations already applied
in production.

## Verified state (2026-10-09)

- `master` = `d7d80b0` — has marbetes work + migrations 0011–0014. No MFA.
- `feat/synthetic-test-data` = `7a43e2a` — has MFA + 0015–0020, but branched
  from `f2812a7` (BEFORE 0012–0014 / matriculas / asociar), so it lacks master's
  newer work and would delete it on a naive merge.
- `feat/mfa-canvas-integration` = `f2e00c6` — **existing integration branch**
  (PR #11), branched from `master@2431525` (which already has matriculas +
  asociar + 0011–0014). Contains MFA M1–M6 + device assignment (B2) +
  access-decisions + migrations 0015–0019. Does NOT contain 0020 or the
  synthetic seeders. This is the correct source for the reconcile.

## Strategy decision

**Selective merge, not cherry-pick.** `feat/mfa-canvas-integration` is already a
clean integration of the MFA surface onto a master baseline. `git merge-tree`
reports a **clean merge** (0 conflicts) of `feat/mfa-canvas-integration` into
`master` because the two sides touched disjoint regions since merge-base
`2431525`. This preserves master's marbete-catalog reveal + scope-unification
work AND brings the MFA + device-assignment + access-decision surface in one
reviewable merge.

Scope: MFA + its runtime dependencies (device `assigned_student_id` from 0015,
device-assignment B2 routes, access-decisions). Migration 0020
(`students_sis_id`) and the synthetic seeders are **out of scope** — documented
as remaining delta below.

## Task units

- [ ] WU1 — `feat/mfa-reconcile` from master + merge `feat/mfa-canvas-integration`
- [ ] WU2 — add `apps/api/scripts/mfa-authenticate-smoke.sh` (from `feat/synthetic-test-data`)
- [ ] WU3 — verify migration tree 0011–0019 (no renumber), full `ci-checks.sh` green
- [ ] WU4 — document remaining delta + RDD review

## MFA contract (do not break)

- scope = `mfa.access`; subject = `String(student.canvas_user_id)`.
- Flow `{ marbete_code, serial_number, otp }` → active marbete + active device
  bound to the same student → session `kind='student'`.
- Marbete resolved by `code_hash` (sha256) via `pg-mfa-repo.ts`; OTP verified
  against quorum-otp `POST /v1/otps/verify` (field `token`).
- Never touch `quorum-otp`; only the backoffice.

## Remaining delta (git vs /opt, out of scope)

- Migration `0020_students_sis_id.sql` (nullable PII + `sis_id`) — synthetic/SIS
  concern, not required by MFA. Present in production + `feat/synthetic-test-data`.
- Synthetic test-data seeders (`apps/api/scripts/synthetic/**`) — deliberately
  excluded (they polluted production on 2026-10-06).
- Any hostPath-only assets under `/opt/quorum-backoffice` not represented in git.

## Acceptance criteria

- [ ] `master`-based branch compiles with 0 typecheck errors.
- [ ] Backoffice unit + MFA integration suites green (against disposable DB).
- [ ] Delta documented here and in Engram.
- [ ] No push/merge to master, no deploy — user decisions.
