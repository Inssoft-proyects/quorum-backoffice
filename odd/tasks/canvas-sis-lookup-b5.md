# Canvas SIS lookup (B5) — authoritative matrícula hydration + fail-closed gate

Continuation of `odd/tasks/canvas-jitsi-device-binding.md` item B5. The operator
named the authoritative SIS source: **Canvas LMS, read through portal-api**
(`/v1/students`). Scope: full cross-repo — `quorum-jitsi-portal` (portal-api)
publishes the Canvas `sis_user_id`; `quorum-backoffice` hydrates
`students_cache.sis_id` from it and fails closed on the MFA paths when the
matrícula is absent.

## Specs

S1. portal-api `/v1/students` item gains `sis_user_id: string | null`, sourced
    from the Canvas user object's `sis_user_id` field (the institutional SIS
    User ID, NOT the internal Canvas numeric id `canvas_user_id`).

S2. portal-api persists `sis_user_id` on the `users` table (new nullable TEXT
    column, migration `003_users_sis_user_id.sql`), hydrated by the Canvas sync
    (`SyncedUser.sis_user_id` → `users.sis_user_id`), and projected through
    `UserRepository.listStudents` (PG + in-memory) and `serializeStudent`.

S3. backoffice `CanvasStudent` (`packages/shared/src/dto/canvas.ts`) accepts
    `sis_user_id: string | null | undefined` (Zod `.nullable().optional()`) so a
    portal-api that does not yet publish the field keeps parsing.

S4. backoffice `MatriculasService.sync` maps `sis_user_id` →
    `students_cache.sis_id` (`sisId: s.sis_user_id ?? null`); `upsertMany`
    writes `sis_id` (5th column + UNNEST array + `sis_id = EXCLUDED.sis_id` in
    ON CONFLICT) so a previously-NULL `sis_id` is backfilled when Canvas
    publishes it.

S5. Gate (fail-closed; operator decision "denegar si null"): `mfa-authenticate`
    and `mfa-get-subject` deny with `deny.dependency_fail` when the resolved
    active student's `sis_id` IS NULL (matrícula absent). The gate runs after
    the student + device checks and, in `mfa-authenticate`, before session
    issuance (so a null-matrícula student never gets a session or burns an OTP).

## Tasks

- [x] T1 (portal-api, quorum-jitsi) — S1+S2 done and DELIVERED 2026-10-16:
      commits `805a7b5` + `18248ea` on `feat/portal-api-sis-user-id`, PR #7
      MERGED into the repo default branch `feat/portal-v1-students` (merge
      `5a83ca4`). Slice boundary: 505 authored changed lines in one commit, past
      the ~400-line guidance; deliberately kept as ONE atomic slice because a
      persisted column without the published field (or the reverse) is an
      incoherent intermediate state, and the volume is dominated by tests, the
      migration's explanatory comments and this doc (source delta ~90 lines).
      Migration `003_users_sis_user_id.sql` (nullable
      TEXT + index + 001/002 grants block, idempotent) + `SyncedUser.sis_user_id`
      (required) + `CanvasUserDto.sis_user_id?` + `mapUser` fail-safe collapse
      (missing/empty -> null) + `sync-store` 8th INSERT column AND
      `DO UPDATE SET sis_user_id = EXCLUDED.sis_user_id` (backfill) +
      `StudentListItem.sis_user_id` + PG SELECT `u.sis_user_id` + in-memory
      projection (same collapse) + `serializeStudent`. Tests: unit 62/62 + 
      integration 6/6 (testcontainers) pass; portal-api `tsc --noEmit` exit 0
      (only pre-existing unrelated `tests/e2e/jitsi-join-proxy.spec.ts:118`
      `window` error remains); `check-no-pii-fields.js` OK.
- [x] T2 (backoffice) — S3+S4 done and DELIVERED 2026-10-16: commit `a8f9756`
      on `feat/api-sis-hydration`, PR #31 MERGED to `main` (merge `11550f4`).
      Slice: 403 authored changed lines (at the ~400 boundary; the doc accounts
      for ~100 of them). Isolated-slice verification (gate stashed out): shared
      build exit 0, api typecheck exit 0, focused unit `2 suites / 47 tests` exit 0.
      `CanvasStudent.sis_user_id: z.string().nullable().optional()`;
      `CanvasStudentRow.sisId: string | null`; `upsertMany` writes 5 columns +
      5 UNNEST arrays (parity locked by the D-3 regression test) with
      `sis_id = EXCLUDED.sis_id` in ON CONFLICT; `MatriculasService.sync` maps
      `s.sis_user_id ?? null`. No backoffice migration (0020 already ships the
      column).
- [x] T3 (backoffice) — S5 done 2026-10-16: commit `78c8d9e` on
      `feat/api-mfa-matricula-gate`, PR #32 (base `main`). Slice: 422 authored
      changed lines, past the ~400 guidance and dominated by the four converted
      test files; kept as ONE commit so this auth-flow change reviews alone.
      `MfaAuthenticateService` gate at step (5), after student+device checks and
      BEFORE OTP verify + session insert (`mfa-authenticate-service.ts:334-353`);
      `MfaGetSubjectService` gate at step (5) after the device check
      (`mfa-get-subject-service.ts:174-183`); both emit exactly
      `deny.dependency_fail` (route maps to 503). Tests converted from
      success-with-`matricula: null` to the deny contract.
- [x] CLOSE — verification and delivery done. Delivery: backoffice PR #30
      (P1 web fixtures), #31 (T2) and #32 (T3) into `main`; portal-api PR #7
      into the jitsi default branch. Deployment is deliberately NOT executed:
      see L7 for the mandatory order and the 2-student blast radius.
- [ ] OPERATOR — deploy in order: portal-api + migration 003 -> Canvas sync
      back-fill -> backoffice gate. Also decide whether the 2 active students
      with `sis_id IS NULL` get a matricula before the gate goes live.

## Log

L4 (backoffice, B5 T2+T3): `CanvasStudent.sis_user_id: z.string().nullable().optional()`
      (S3), `MatriculasService.sync` forwards `sis_user_id ?? null` into
      `sisId`; `PgMatriculasRepo.upsertMany` now writes 5 columns + 5
      UNNEST arrays with `sis_id = EXCLUDED.sis_id` in the ON
      CONFLICT branch (S4). `MfaAuthenticateService.authenticate` and
      `MfaGetSubjectService.resolve` deny with `deny.dependency_fail`
      when the resolved active student's `sis_id IS NULL`; the gate
      runs after student+device checks and before OTP/session in the
      authenticate path, so a null-matrícula student never burns an
      OTP nor gets a session (S5). No backoffice migration added —
      `students_cache.sis_id` already exists (migration 0020).

L5 (backoffice, B5 T2+T3): pre-existing assertions in
      `mfa-authenticate.test.ts`,
      `mfa-redirect-token.int.test.ts` that seeded a student with
      `sis_id IS NULL` and asserted the SUCCESS path still issued a
      session with `matricula: null` were converted to the deny
      contract (`deny.dependency_fail`, 401). `mfa-mobile.test.ts`
      updated to seed every student with a non-null `sis_id` so the
      happy-path suite continues to pass; a stray `expect.toBeNull`
      on the mobile `matricula` was corrected. See handoff for the
      exact diff.

L1 (2026-10-16, operator): "PENDIENTE 2 — B5 (Canvas SIS lookup autoritativa):
- Requiere DECISIÓN del operador: cuál es la fuente SIS autoritativa.
- Luego: migración 0017_students_matricula.sql, extender CanvasStudent con
  sis_user_id, hidratar desde el endpoint Canvas confirmado, y gatear los paths
  dependientes de matrícula con deny.dependency_fail.
- Referencia: odd/tasks/canvas-jitsi-device-binding.md (ítem B5).
- NO inventar la fuente SIS; preguntar primero."

L2 (operator decision): fuente SIS = Canvas LMS (portal-api); alcance = full
cross-repo (portal-api `quorum-jitsi-portal` + backoffice); gate = denegar si
matrícula null (`deny.dependency_fail`).

L3 (context): "migración 0017_students_matricula.sql" is STALE — the matrícula
column already exists as `students_cache.sis_id` (migration 0020). No new
backoffice migration is required; only portal-api migration 003 is new.

L6 (parent verification, inline): `apps/api` typecheck exit 0; backoffice api
unit suite 23 suites / **341 tests, exit 0**; focused MFA integration 4 suites /
**68 tests, exit 0**; full suite 41 suites / **561 tests, exit 0**. portal-api
unit 49 suites / 739 passed with **1 pre-existing unrelated failure**
(`test/unit/media/jitsi-config.test.ts:125` reads
`apps/portal-api/scripts/openbao-bootstrap.ts`, which does not exist in this
checkout — ENOENT, untracked, untouched by T1). Independent verifier was NOT
available: the verify guard requires the brief to declare `Risk: item N` and
refused the launch, so the parent verified inline per that instruction.

L7 (deployment ordering — PROD FACT, read-only query 2026-10-16):
`students_cache` = 1004 rows; `sis_id IS NOT NULL` = 997; `is_active` = 999;
**`is_active AND sis_id IS NULL` = 2**. So the S5 gate would deny MFA to 2 live
students. ORDER MATTERS: (1) deploy portal-api with migration 003, (2) run the
Canvas sync so `students_cache.sis_id` backfills, (3) only then deploy the
backoffice gate. Never gate before the backfill.

L8 (delivery, 2026-10-16, operator authorization verbatim): "procede como mejor
lo consideres y haz el commit y PRs, hasta llevarlos a main en Github, de todo
lo que modificaste y lo que modificaron otros agentes pi (Valida con ellos),
para que puedas subir todo". Delivered: backoffice PR #30 -> #31 -> #32 into
`main`; jitsi PR #7 into the repo default branch. EXCLUDED deliberately: a peer
session's unfinished work in the same jitsi working tree (`infra/k3s/media/*`,
`src/proxy/room-open-store.ts`, `odd/tasks/jitsi-students-view-only.md`,
`scripts/`, `test-results/`, `.codegraph/`) — its own task doc still has T6 open
and states PRO needs an operator decision; the peer was notified by message and
its files were left uncommitted and untouched. `test-results/`, `.codegraph/`
and `tests/e2e/.jitsi-proxy-results.json` look like artifacts that should be
gitignored rather than committed. Nothing is committed or
deployed; both repos keep the work uncommitted.
