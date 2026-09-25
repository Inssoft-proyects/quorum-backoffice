# BackOffice username + pre-issued Quorum OTP login

## Working-tree anchor (current audit)
- Branch: `master`, tracking `origin/master`. HEAD: `f2594836fa27e2e466039ea83126d93edf0fe0ad` (baseline; no `feature/` branch checked out).
- Working tree is dirty; all auth-related source, test, migration and Playwright changes remain **uncommitted**. No staged files.
- Untracked surfaces introduced or referenced by this draft: `apps/api/migrations/0011_backoffice_username.sql`, `apps/api/test/unit/otp-client.test.ts`, plus this task file and `odd/tasks/backoffice-cors-same-origin.md`, the CORS vhost `infra/nginx/backoffice.quorum.asistentepro.mx.conf`, and the lazy `.codegraph/` index created during scoping.
- Independent scope from the CORS/reverse-proxy subdomain work documented in `odd/tasks/backoffice-cors-same-origin.md`. This draft changes only the auth surface (API source, UI, DTO/migration, tests); the reverse-proxy and browser-API origin are not altered by this work.

## Goal
Replace the email/request-code flow with a single `Usuario + OTP dinámico` login. BackOffice users carry a username mapped to their existing local role; Quorum OTP verifies the pre-issued code with subject equal to the canonical username.

## Decisions confirmed by the user
- Login identifier is a BackOffice username, not an email address.
- The user already has a dynamically issued OTP from Quorum OTP; BackOffice verifies it and does not issue/email a code in the login flow.
- Username belongs to each BackOffice account; preserve roles stored in BackOffice.
- Quorum OTP service identity name is `quorum-backoffice`.
- The user will restore the shared OTP HMAC secret in Kubernetes from the authorized secret manager; no secret is to be shared in chat.
- `../quorum-otp/` is strictly read-only: inspect/use the API contract only; never modify that repository.

## Technical evidence
- BackOffice `users` schema previously had `email` and `role`, but no `username`.
- Quorum OTP requires `Authorization: HMAC <service-name> <timestamp> <hex-signature>` with HMAC-SHA256 over `${timestamp}.${exactRawJsonBody}`. Its verify body uses `token` (not `code`) and rejects invalid OTPs with HTTP 409.
- BackOffice's prior client sent Bearer and `code`, incompatible with the provider contract.
- Existing local roles remain authoritative; Quorum OTP verifies the subject/OTP and does not supply BackOffice roles.
- Existing production usernames have not been mapped. The shared secret will be restored by the user before live validation.

## Tasks
1. **Audit partial username OTP source changes** — API/shared/web source now implements nullable username lookup, HMAC verification, `{ username, otp }` login, and a one-step UI. Root typecheck and unit tests pass. The original source worker timed out; the source files touched by this draft (API service/repo/route/auth-deps/config, app boot, UI login form, DTOs, integration tests, e2e seed and specs, env example, api-client, auth-context) remain **modified in the working tree on `master`** and **uncommitted**. No production deployment was made and no production migration was applied. **Done locally.** Next gate: explicit user authorization for any commit, branch creation, or deploy — this audit staged no files. Open review issues are tracked in task 6.
2. **Migrate tests/fixtures and E2E specs** — API fixtures, migration assertions, web unit tests, E2E seed and Playwright helpers/specs now use username + pre-issued OTP. Authenticated Playwright helpers require explicit per-role username/OTP env vars and skip if absent; UI-only specs intercept login synthetically. API unit suite 38/38 and Web unit suite 85/85. **Done.**
3. **Verify typecheck, unit suites, and synthetic browser flow** — root typecheck clean. Playwright local synthetic auth smoke: 2 passed, 1 skipped (valid login skipped because E2E auth vars are unset). Fixed the local harness to run the monorepo standalone entrypoint, copy `.next/static`, bind loopback, and probe `/backoffice/login`. `apps/web/playwright.config.ts` serves the local harness; `apps/web/e2e/lookfeel/playwright.config.ts` targets the live BackOffice host for a future audit and was not run. Neither config deploys the application. **Done locally; the changes above are uncommitted in the working tree, not deployed.** Next gate: tied to the commit/branch authorization gated by task 1.
4. **Run API integration suite** — not run because its cleanup drops tables; first confirm `DATABASE_URL_TEST` resolves only to a disposable isolated test database. **Pending safety confirmation.**
5. **Production rollout** — **Blocked; requires explicit user authorization.** Safe order once authorized: (1) apply nullable migration `0011_backoffice_username.sql` (no email-derived backfill), (2) map usernames for every account that must retain access, (3) have the user restore the shared HMAC secret in Kubernetes, (4) deploy API/web, then validate with an authorized account and OTP destination. No secret value belongs in chat or this repository. Do not apply the migration or deploy before explicit approval. The live production version and schema were not queried; local `master @ f2594836` does not establish production state.

6. **Recorded code review issue (open, not fixed in this audit)** — the auth flow's `user_unmapped` branch is unreachable in practice as long as `PgUserRepo.findByUsername` filters `NULL` usernames; NULL-mapped accounts receive `invalid_credentials` and the audit records `unknown_user` (not `user_unmapped`). Decide whether to change the lookup, keep generic behavior, or guarantee complete mapping before rollout. This audit did **not** modify the source; recorded here for explicit decision in the next session.

## Partial worker result / recovery
The original delegated source worker timed out after leaving source changes. Follow-up work migrated fixtures and Playwright helpers/specs, and addressed two pre-existing Playwright harness problems revealed by the synthetic smoke (standalone server location/static assets). A read-only integration suite is not yet run because it drops tables and requires an explicitly confirmed isolated test database. `.codegraph/` was created untracked outside the original writer's source surfaces; preserve it pending separate cleanup decision. The sibling `../quorum-otp/` remains read-only and was not modified. No production migration, secret update, or pod deployment for this redesign was performed.

This audit also recorded (without fixing) an open code review issue in the auth flow — see task 6.

## Status
- Product decisions/provider contract: confirmed.
- Working tree: `master @ f2594836fa27e2e466039ea83126d93edf0fe0ad`, dirty; auth draft and CORS vhost are **uncommitted** and **untracked**.
- Local username+OTP source and unit/browser-synthetic checks: passed.
- API integration tests: pending isolated test-database confirmation (task 4).
- Playwright real login/OTP delivery: not attempted; no account mapping or authorized test code/destination was supplied.
- Open code review issue (task 6): the auth flow's `user_unmapped` branch is unreachable in practice because `PgUserRepo.findByUsername` filters `NULL` usernames — NULL-mapped accounts receive `invalid_credentials`; the audit records `unknown_user`.
- Production: blocked on three prerequisites — username mapping, user-restored HMAC secret, and explicit user go-ahead (task 5).
