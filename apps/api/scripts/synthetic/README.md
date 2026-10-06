# Synthetic Test-Data Seeder

Two idempotent scripts that seed a backoffice environment with
high-privacy synthetic students, marbetes, and devices. They are
designed to be safe to run in any non-production environment and to
be re-runnable for fixture regeneration.

> **Privacy note** — synthetic students carry **NO personal data**.
> Only the SIS matrícula (6 chars `[A-Z0-9]`) identifies the row.
> In Canvas, the required name / short_name / sortable_name /
> sis_user_id / login fields are **all pseudonyms derived from
> the matrícula itself** (e.g. `matricula.toLowerCase() +
> @synthetic.invalid`). The 6 existing Canvas users
> (admin.test / designer.test / observer.test / student.test /
> ta.test / teacher.test @quorum.local) are never touched.

## Scripts

### A — `canvas-students.ts`

Creates N synthetic students in Canvas LMS via the REST API.

```bash
cd apps/api
CANVAS_ADMIN_TOKEN=... \
npx tsx scripts/synthetic/canvas-students.ts
```

Required env:

| Variable | Default | Notes |
| --- | --- | --- |
| `SYNTHETIC_STUDENT_COUNT` | `1000` | Positive integer. |
| `CANVAS_BASE_URL` | `https://lms.quorum.asistentepro.mx` | No trailing slash. |
| `SYNTHETIC_CANVAS_ACCOUNT_ID` | `2` | Root account id (tenant's "Default Account"). Verified against the live instance: account id 1 does not exist for the production token, and `GET /api/v1/accounts/2` returns `parent_account_id: null`. |
| `CANVAS_ADMIN_TOKEN` | _REQUIRED_ | Bearer token (env-only). |
| `SYNTHETIC_SEED` | `quorum-synthetic-v1` | Same seed → same matriculas. |
| `SYNTHETIC_OUTPUT` | `apps/api/scripts/synthetic/out/students-mapping.json` | Where the mapping JSON is written. |
| `SYNTHETIC_CONCURRENCY` | `5` | Max in-flight requests. |
| `SYNTHETIC_TIMEOUT_MS` | `15000` | Per-request timeout. |

The output mapping JSON has the shape:

```json
{
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "seed": "quorum-synthetic-v1",
  "count": 1000,
  "entries": [
    { "sisId": "ABC123", "canvasUserId": 42 },
    ...
  ]
}
```

A row is `created` on a fresh POST, `reused` when Canvas returns
400 / 409 / 422 (the script then looks the user up by
`GET /api/v1/users/sis_user_id:<sisId>`), or `failed` after
retries. A failed row never aborts the run.

### B — `backoffice-data.ts`

Loads synthetic data into the backoffice Postgres. Reads the
mapping JSON from Script A and inserts:

1. One `students_cache` row per mapping entry (`canvas_user_id`,
   `sis_id`, `full_name = NULL`, `email = NULL`, `is_active = TRUE`).
2. Exactly 10 `marbetes`, one per the first 10 mapping entries in
   deterministic order. Codes are the 10 secrets `VALIDO-2609982468`
   through `VALIDO-2609982477` hashed with sha256. The plain
   `publicMessage` / `secretMessage` values are **never** written
   to the database.
3. `SYNTHETIC_DEVICE_COUNT` devices in `dispositivos` (16-char
   lowercase hex serials). The **first** serial is the constant
   `f401e1afcfd09b16` (MFA smoke fixture).
4. Device-student assignments, 1:1 across `min(devices, students)`.
   Device `f401e1afcfd09b16` and marbete `VALIDO-2609982468` are
   both assigned to the **first** student in the mapping, so the
   MFA triple validates end-to-end.

```bash
cd apps/api
DATABASE_URL=postgresql://... \
npx tsx scripts/synthetic/backoffice-data.ts
```

Required env:

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | _REQUIRED_ | Only env var the script reads. Does NOT reuse the API's `loadConfig` — REDIS_URL / OTP_* / CANVAS_PORTAL_* / SESSION_SECRET are not required. |
| `SYNTHETIC_OUTPUT` | `apps/api/scripts/synthetic/out/students-mapping.json` | Mapping JSON from Script A. |
| `SYNTHETIC_SEED` | `quorum-synthetic-v1` | Same seed → same device serials. |
| `SYNTHETIC_DEVICE_COUNT` | `1000` | Must be `>= 1000`. |
| `LOG_LEVEL` | `info` | Optional. Standard pino levels. |

The script prints a final summary with counts and the MFA triple
(marbete code, publicUid, serial, sis_id, canvas_user_id).

## Idempotency

Both scripts are safe to re-run:

- Script A: re-running POSTs the same matriculas; Canvas returns
  400/409 for existing users, and the script looks them up and
  reuses their canvas id.
- Script B:
  - `students_cache`: `ON CONFLICT (canvas_user_id) DO UPDATE`
    re-asserts `sis_id` and the NULL PII shape.
  - `marbetes`: `ON CONFLICT (public_uid) DO UPDATE` re-asserts
    `code_hash`, the assignment, `assigned_at`, and clears
    `deleted_at`. If a target student already has an active
    marbete under a different `public_uid` (which would
    violate the partial unique index
    `uq_marbete_active_per_student`), Postgres raises 23505
    and the script traps it as a per-row failure (logged via
    pino at warn level and returned in the `marbeteFailures`
    array of the summary). The rest of the batch and the rest
    of the script continue; the failure is never fatal.
  - `dispositivos`: `ON CONFLICT (serial_number) DO NOTHING` keeps
    the original row; the assignment UPDATE then runs
    UNCONDITIONALLY and CLOBBERS any pre-existing manual
    re-assignment of a synthetic device to a different student.
    This is the intended synthetic-fixture behavior — the device
    must point at the fixture student for the MFA triple to
    hold — but it is NOT a true no-op on re-runs.

## Privacy

Synthetic students carry **no name, email, phone, or address**.
The Canvas user record is created with `skip_registration=true`
and **no** `communication_channel` params, so Canvas does not
create an email channel and does not send a confirmation email.

The 6 existing Canvas users (admin.test, designer.test,
observer.test, student.test, ta.test, teacher.test) are never
referenced, never updated, and never matched against synthetic
matriculas.

## Files

- `canvas-students.ts` — Script A
- `backoffice-data.ts` — Script B
- `lib/generate.ts` — Pure helpers (matriculas, serials, PRNG)
- `out/students-mapping.json` — Mapping output (gitignored)
- `README.md` — This file

## Out directory

The `out/` directory is gitignored. The mapping JSON is
operator-local and may contain real Canvas user ids from the
target environment.
