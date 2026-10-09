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

- [x] WU1 — `feat/mfa-reconcile` from master + merge `feat/mfa-canvas-integration` (commit `287ee20`)
- [x] WU2 — add `apps/api/scripts/mfa-authenticate-smoke.sh` (commit `09d76e4`)
- [x] WU3 — verify migration tree 0011–0019 (no renumber) + `ci-checks.sh` (see Verification)
- [x] WU4 — document remaining delta + attempt RDD review (see RDD review outcome)

## MFA contract (do not break)

- scope = `mfa.access`; subject = `String(student.canvas_user_id)`.
- Flow `{ marbete_code, serial_number, otp }` → active marbete + active device
  bound to the same student → session `kind='student'`.
- Marbete resolved by `code_hash` (sha256) via `pg-mfa-repo.ts`; OTP verified
  against quorum-otp `POST /v1/otps/verify` (field `token`).
- Never touch `quorum-otp`; only the backoffice.

## Remaining delta (git vs /opt, out of scope)

- Synthetic test-data seeders (`apps/api/scripts/synthetic/**`) — deliberately
  excluded (they polluted production on 2026-10-06).
- Any hostPath-only assets under `/opt/quorum-backoffice` not represented in git.

Migration `0020_students_sis_id` is now **included** (it was a hard dependency:
`master`'s `pg-matriculas.ts` already referenced `students_cache.sis_id`, so the
matriculas list 500'd without it — see Findings).

## Verification (2026-10-09, final — ALL GREEN)

`DATABASE_URL_TEST=… bash scripts/ci-checks.sh` (full gate, EXIT 0):

- shared build + typecheck — OK
- api typecheck — OK (0 errors)
- api unit — 21 suites / 295 tests passed
- web typecheck — OK
- web unit — 31 suites / 221 tests passed
- standalone-assets smoke + postbuild wiring — OK
- **api integration — 17 suites / 216 tests passed (0 failed)** (incl. MFA
  `mfa-authenticate`/`mfa-mobile`/`mfa-redirect-token`, device-assignment,
  access-decisions, matriculas, marbetes, rbac).

## Findings (all resolved on this branch)

- `--testPathPattern` (jest 30) → `--testPathPatterns` — fixed (commit `8301f08`).
- `otp_grants` grant-cache leak across destructive-op test suites → clear
  `otp_grants` in `beforeAll` — fixed (commit `2309ff6`).
- Matriculas `seedMarbete` SQL interpolation (`'a'.repeat(64)` → `${…}`) +
  sync mock emails (`sa@x` → `sa@x.com`) — fixed (commit `2309ff6`).
- Matriculas OTP mock read `code` instead of wire field `token`, and omitted
  `valid:true` → `otp_service_unexpected_body` 503 — fixed (commit `2309ff6`).
- `master` referenced `students_cache.sis_id` without migration 0020 → list 500
  `column s.sis_id does not exist` — fixed by adding 0020 (commit `a9ac08d`).
- Matriculas list `.toISOString()` on null `assigned_at`/`last_synced_at` → 500 —
  fixed with nullable DTO + guards (commit `159609f`).

## RDD review outcome (2026-10-09)

RDD switch = ON (global). `inspect` resolved. Two attempts:
1. Whole-repo candidate (controller default, no prior lineage → base = empty
   commit `2799de57`) → **terminal `lens_context_budget_exceeded`** (~500 paths).
2. Scoped committed range (START with `baseRef=master d7d80b0` +
   `committedOnly`) → controller rejected with
   `native-start-retained-selection-candidate-mismatch` (the retained
   workspace untracked-exclude selection does not match a committed-range
   candidate). No review authority created; nothing to abandon/repair.

Resolution options (user decision):
- Split the MFA surface into a chained sequence of smaller reviewable commits
  (M1 / M2 / M3 / B2 / access-decisions), each under budget, and review each.
- Skip re-review: the MFA code was already reviewed when it landed as
  `feat/mfa-canvas-integration` (PR #11) with approved RDD lineages per Engram.

## Acceptance criteria

- [x] `master`-based branch compiles with 0 typecheck errors.
- [x] Backoffice unit + MFA integration suites green (against disposable DB).
- [x] Delta documented here and in Engram.
- [ ] No push/merge to master, no deploy — user decisions.
