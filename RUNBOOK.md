# Quorum Backoffice — Operations Runbook

This runbook covers the day-to-day operational concerns for the Quorum
Backoffice service.

## Architecture

- **API**: Node 22 + Fastify 5 + PostgreSQL 18 + Redis 8. Listens on port
  3100 (dev) or 4100 (prod).
- **Web**: Next.js 15 App Router + React 19 + TypeScript 5 + Tailwind 4 +
  shadcn/ui. Listens on port 3002 (dev) or corresponding prod port.
- **Shared**: `packages/shared` — Zod DTOs and types. Built to `dist/` and
  consumed by both apps.

## Ports

| Service | Dev | Prod |
| --- | --- | --- |
| API    | 3100 | 4100 |
| Web    | 3002 | 4002 |
| PG     | 5432 | 5432 |
| Redis  | 6379 | 6379 |

## Environment variables

### API (`apps/api`)

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | — | `postgresql://user:pass@host:5432/db` |
| `REDIS_URL` | yes | — | `redis://host:6379` |
| `OTP_SERVICE_URL` | yes | — | `http://quorum-otp:3000` |
| `OTP_SERVICE_TOKEN` | yes | — | HMAC bearer token for OTP service |
| `CANVAS_PORTAL_API_URL` | yes | — | `http://portal-api:3000` |
| `CANVAS_PORTAL_API_TOKEN` | yes | — | HMAC bearer token for portal-api |
| `SESSION_SECRET` | yes | — | ≥32 chars; HMAC for cookie |
| `SESSION_TTL_SECONDS` | no | 3600 | Session lifetime |
| `AUTH_COOKIE_NAME` | no | `sid` | Set to `__Host-sid` in prod (requires Secure flag) |
| `AUTH_COOKIE_SECURE` | no | true | Set to false only in dev/test |
| `AUTH_LOGIN_MAX_ATTEMPTS` | no | 5 | Per-email rate limit |
| `AUTH_LOGIN_WINDOW_SECONDS` | no | 900 | 15 minutes |
| `API_HOST` | no | `127.0.0.1` | Bind host |
| `API_PORT` | no | 3100 | Bind port |
| `LOG_LEVEL` | no | info | `fatal|error|warn|info|debug|trace` |
| `NODE_ENV` | no | development | `development|test|production` |
| `BOOTSTRAP_ADMIN_EMAIL` | no | — | Optional: create initial admin on boot |
| `BOOTSTRAP_ADMIN_PASSWORD` | no | — | Optional: initial admin password |

### Web (`apps/web`)

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | yes (prod) | `http://127.0.0.1:3100` | API base URL the browser hits |

## Health endpoints

- `GET /healthz` — Liveness. Always 200 if the process is alive.
- `GET /readyz` — Readiness. Deep-checks PG, Redis, and OTP service in
  parallel. Returns 200 + `{status:'ok',checks:{...}}` when PG + Redis are
  up; 503 + `{status:'degraded',checks:{...}}` otherwise. OTP is
  reported but does not affect the status code.
- `GET /metrics` — Prometheus metrics. Default port 9090 not exposed;
  integrate via sidecar.

## Operational tasks

### Migrations

```bash
cd apps/api && npm run migrate
```

Reads `apps/api/migrations/*.sql` in order, tracks applied files in
`_migrations` table, runs each in a transaction. Idempotent.

### Bootstrap admin user (production)

After running migrations, create the first admin via SQL:

```sql
-- Generate bcrypt hash with cost 12 first:
--   node -e "console.log(require('bcrypt').hashSync('your-password', 12))"
INSERT INTO users (email, password_hash, role)
VALUES ('admin@yourdomain', '$2b$12$...', 'admin');
```

Then log in via `POST /api/v1/auth/login` and rotate the password.

### Rotate a session secret

`SESSION_SECRET` is used to HMAC-sign cookies. Rotating invalidates
all active sessions — users get logged out. Plan maintenance window or
notify users.

### Add a new audit action

The `audit_action` enum is defined in `0004_audit.sql`. To add a new
action:

```sql
ALTER TYPE audit_action ADD VALUE 'new_entity.action';
```

Then update:
1. `packages/shared/src/dto/audit.ts` — `AuditAction` enum.
2. `apps/api/src/services/<entity>-service.ts` — use the new action in
   `AuditService.write()` calls.

### Inspect audit log

```sql
-- Recent destructive operations
SELECT occurred_at, actor_id, action, entity_id, otp_id
FROM audit_log
WHERE action IN ('marbete.delete', 'dispositivo.revoke')
ORDER BY occurred_at DESC
LIMIT 50;

-- Verify REVOKE PUBLIC still in place (append-only enforcement)
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_name = 'audit_log'
  AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE');
-- Must return zero rows with grantee='PUBLIC'.
```

### Verify Redis rate-limit counters

```bash
redis-cli KEYS 'login_attempts:*' | head
redis-cli GET 'login_attempts:admin@yourdomain'
redis-cli TTL 'login_attempts:admin@yourdomain'
```

The counter increments per failed login. Reset with `redis-cli DEL`.

## Common alerts

| Alert | Likely cause | Action |
| --- | --- | --- |
| /readyz returns 503 | PG or Redis down | Check `docker compose ps`, `pg_isready`, `redis-cli ping` |
| Login 429 spike | Brute force or credential leak | Check `audit_log WHERE action='auth.failed'`, rotate creds, consider blocking IP at edge |
| Audit log growth slow | Old `_migrations` not pruning | Archive > 1 year to cold storage; never DELETE |
| OTP 503 in /readyz | quorum-otp service down | Check quorum-otp health; auth still works for already-issued sessions |

## Disaster recovery

- **PG corruption**: restore from nightly backup; re-run migrations are
  no-op due to `_migrations` tracking.
- **Redis loss**: rate-limit counters reset (brute-force window resets);
  sessions in `sessions` table still valid; users may stay logged in
  until cookie TTL expires (no session lookup needs Redis).
- **quorum-otp loss**: existing sessions unaffected (no OTP needed for
  GETs); destructive operations (POST/PATCH/DELETE marbetes/dispositivos)
  fail with 503 until OTP service returns.

## E2E test setup

Before running `npm run test:e2e` from `apps/web`, seed three users via
direct SQL (cost-12 bcrypt hashes):

```sql
-- These hashes correspond to password 'admin1234', 'operator1234', 'auditor1234'
-- generated with bcrypt cost 12. Replace with your own hashes for real E2E.
INSERT INTO users (email, password_hash, role) VALUES
  ('admin@quorum.local',    '$2b$12$...admin1234...', 'admin'),
  ('operator@quorum.local', '$2b$12$...operator1234...', 'operator'),
  ('auditor@quorum.local',  '$2b$12$...auditor1234...', 'auditor');
```

Or override via env vars:
- `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD`
- `E2E_OPERATOR_EMAIL` / `E2E_OPERATOR_PASSWORD`
- `E2E_AUDITOR_EMAIL` / `E2E_AUDITOR_PASSWORD`

Then run from `apps/web`:

```bash
npm run test:e2e
```

The Playwright config starts `next build && next start` automatically
via `webServer`. Pre-existing dev server on port 3002 is reused if
`reuseExistingServer` is enabled (default outside CI).

## Limitations

### Playwright browser download

Playwright tests require a Chromium binary. If the host environment
cannot reach the Playwright CDN (firewall, no outbound network, or
disk constraints), run:

```bash
npx playwright install chromium
```

If that command fails in this environment, the test files in
`apps/web/e2e/` are still authored and will run in a properly
provisioned CI environment. They will not execute locally until the
browser is downloaded.

### OTP service health probe

The OTP probe in `/readyz` calls `${OTP_SERVICE_URL}/healthz` with a
2-second timeout. If `OTP_SERVICE_URL` points at a host that has no
`/healthz` route, `/readyz` will report `otp: 'down'`. This is by
design — the OTP service must expose a health endpoint — but it means
`/readyz` will show a non-`ok` OTP check during outages or until the
OTP service ships its own `/healthz`.

## Web lint status

The `apps/web` project does not currently run ESLint as part of `npm
run lint`. Reason: Next.js 16 (installed at 16.3.5) removed the
`next lint` command entirely. The web lint script currently delegates
to `tsc --noEmit` (TypeScript) which catches type errors but not
style/lint issues.

When the project adds ESLint (a future polish WU), update the script
in `apps/web/package.json` from the `tsc --noEmit` placeholder to the
appropriate ESLint invocation (likely `eslint .` with a flat
`eslint.config.js` at the web root, plus the `eslint-config-next`
package for Next.js-aware rules).
