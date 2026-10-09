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

- Migration `0020_students_sis_id.sql` (nullable PII + `sis_id`) — synthetic/SIS
  concern, not required by MFA. Present in production + `feat/synthetic-test-data`.
- Synthetic test-data seeders (`apps/api/scripts/synthetic/**`) — deliberately
  excluded (they polluted production on 2026-10-06).
- Any hostPath-only assets under `/opt/quorum-backoffice` not represented in git.

## Verification (2026-10-09)

`bash scripts/ci-checks.sh` (unit gate):

- shared build + typecheck — OK
- api typecheck — OK (0 errors)
- api unit — 21 suites / 295 tests passed
- web typecheck — OK
- web unit — 31 suites / 221 tests passed
- standalone-assets smoke + postbuild wiring — OK

Integration (disposable DB `quorum_backoffice_test` + Redis, run directly with
`--testPathPatterns` because `--testPathPattern` was removed in jest 30 — see
findings):

- **MFA integration suites — 4 suites / 74 tests PASS** (`mfa-authenticate`,
  `mfa-mobile`, `mfa-redirect-token.int`).
- Full integration run: 17 suites / 204 passed, **12 failed** — all 12 are
  pre-existing on `master` (unrelated to MFA): `matriculas`, `marbetes`
  (OTP-enforcement), `rbac`. Baseline on `master` = **29 failed** in the same
  suites, so the merge reduced them to 12 (B7a OTP_SERVICE_NAME HMAC fixes
  landed via the MFA branch) but did not introduce any new failure.

## Findings (pre-existing, NOT introduced by this branch)

- `apps/api/package.json` `test:integration` uses `--testPathPattern`, removed
  in jest 30 (`--testPathPatterns`). `npm run test:integration` (and the
  integration phase of `ci-checks.sh`) exits with a CLI error before running.
  Pre-existing on `master`.
- Marbete destructive-op OTP enforcement is broken on `master`: the
  "rejected OTP" integration cases (POST/PATCH/DELETE without a valid OTP)
  return 201/200 instead of 401. Pre-existing; security-relevant, but out of
  scope for this MFA reconcile (separate remediation).
- Matriculas integration suite fails on `master` (paginated list empty,
  counters 0, sync → 503 Canvas mock). Pre-existing.

## RDD review outcome (2026-10-09)

RDD switch = ON (global). `inspect` resolved (after `gentle-ai sync` and excluding
untracked build artifacts). START is **blocked terminal** with
`lens_context_budget_exceeded`: this repo has no prior review lineage, so the
controller scoped the first candidate as the **entire repository**
(base = initial empty commit `2799de57` → HEAD, ~500 paths), which exceeds the
reviewer lens context budget. No review authority was created; nothing to
abandon/repair.

Resolution options (user decision):
- Split the MFA surface into a chained sequence of smaller reviewable commits
  (M1 / M2 / M3 / B2 / access-decisions), each under budget, and review each.
- Skip re-review: the MFA code was already reviewed when it landed as
  `feat/mfa-canvas-integration` (PR #11) with approved RDD lineages for
  M1/M2/Canvas per Engram.

## Acceptance criteria

- [x] `master`-based branch compiles with 0 typecheck errors.
- [x] Backoffice unit + MFA integration suites green (against disposable DB).
- [x] Delta documented here and in Engram.
- [ ] No push/merge to master, no deploy — user decisions.
