> ⚠️ **Operator alert — read first.**
>
> **Working tree**: `master @ f2594836fa27e2e466039ea83126d93edf0fe0ad`, tracking `origin/master`. Dirty; no staged files. Auth-related source/tests, the migration `0011_backoffice_username.sql`, the CORS vhost, and the ODD task files are **uncommitted** in the tree.
>
> **Auth state — NOT the design below.** The auth flow, `SMTP_*`/`LOGIN_OTP_*` env vars, `POST /api/v1/auth/login/request` + `POST /api/v1/auth/login`, and the OTP delivery section describe the historical Polish WU v6 email + 2-step OTP design, merged into the current `master` baseline `f2594836`. The current working tree has an **uncommitted, undeployed** username + pre-issued OTP draft — see `odd/tasks/backoffice-username-otp.md`. It accepts `{username, otp}` and uses the `OtpClient` HMAC contract; `../quorum-otp/` is read-only; `0011_backoffice_username.sql` is untracked and **not recorded as applied**. The live production version and schema were not queried.
>
> **CORS / subdomain fix — separate scope.** `infra/nginx/backoffice.quorum.asistentepro.mx.conf` (untracked) and the prior task log `odd/tasks/backoffice-cors-same-origin.md` describe a `https://backoffice.quorum.asistentepro.mx` vhost with `/api/` proxy and a previously validated same-origin preflight. **The current audit did not re-verify production**; treat the prior task log as **previously reported/validated, not re-verified now**. The "Production deployment with nginx" section below still describes the older `quorum.asistentepro.mx` vhost pattern.
>
> **Open code review issue (not fixed in this audit).** The auth flow's `user_unmapped` branch is unreachable in practice — `PgUserRepo.findByUsername` filters `NULL` usernames, so NULL-mapped accounts receive `invalid_credentials` and the audit records `unknown_user`. Plan for that mapping gap if this local auth draft is continued.
>
> **Operations NOT to perform without explicit user authorization.** `git reset`/`restore`/`stash`/`checkout`; deletion of working-tree files; `git commit`/`push`; branch switches; migration application against any environment (incl. `0011_backoffice_username.sql`); production deploys; secret restoration in Kubernetes; touching `../quorum-otp/`; running the API integration suite (it drops tables) against a non-disposable DB; real login submissions; any pod restart that depends on uncommitted config.
>
> Next step: confirm scope and authorization with the user before any source edit, commit, deploy, or migration. See `HANDOFF.md` §"Estado actual al cierre de la auditoría" for the full audit report.

---

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
| `SMTP_HOST` | prod only | — | Hostname of the SMTP relay used to deliver login OTPs |
| `SMTP_PORT` | prod only | — | SMTP port (typically 587 for STARTTLS or 465 for TLS) |
| `SMTP_SECURE` | no | false | `true` for implicit TLS (port 465) |
| `SMTP_USER` | prod only | — | SMTP auth user |
| `SMTP_PASS` | prod only | — | SMTP auth password |
| `SMTP_FROM` | no | `no-reply@quorum.local` | From address on OTP emails |
| `LOGIN_OTP_TTL_SECONDS` | no | 300 | OTP validity window |
| `LOGIN_OTP_MAX_ATTEMPTS` | no | 5 | Max wrong codes per OTP |
| `LOGIN_OTP_REQUEST_MAX_PER_EMAIL` | no | 5 | Max OTP requests per email / window |
| `LOGIN_OTP_REQUEST_WINDOW_SECONDS` | no | 900 | 15 minutes |

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

Then trigger an OTP for that address via `POST /api/v1/auth/login/request`
and complete the login with the emailed 6-digit code via
`POST /api/v1/auth/login`. The legacy `password` field on the login
DTO is parsed but ignored — Polish WU v6 moved the surface to
email + OTP and the `users.password_hash` column is preserved on
disk for recovery but no longer verified.

### OTP delivery (Polish WU v6 / A1)

Login OTPs are issued by the sibling `quorum-otp` service and delivered
to the user via SMTP from the backoffice. The two-step contract is:

```http
POST /api/v1/auth/login/request
Content-Type: application/json
{ "email": "admin@quorum.local" }

→ 200 { "ok": true, "retryAfterSeconds": 60 }

POST /api/v1/auth/login
Content-Type: application/json
{ "email": "admin@quorum.local", "otp": "K7QM3X" }

→ 200 { "user": { ... } } + Set-Cookie: __Host-sid=...
```

- The OTP service issues the token (`POST /v1/otps`); the backoffice
  receives it and forwards it to the user via SMTP.
- Both steps are rate-limited per email: 5 OTP requests / 15 min and
  5 verify attempts / 15 min.
- `users.password_hash` is NOT touched by the login flow; it stays on
  disk for legacy recovery but the column can be dropped in a future
  WU once the migration is stable.
- **Production failure modes:**
  - `SMTP_*` missing → service throws `serviceUnavailable` at boot.
    The API does NOT fall back to "log only" in production; the deploy
    fails-closed.
  - OTP service down → login request returns 503; verify returns 503.
  - Mailer error after issue → audit `auth.login.requested` with
    `entityId=delivery_failed:<otpId>` and the user-facing error is
    a generic 503 (no SMTP host leakage).
- **Dev convenience**: if `SMTP_HOST` is unset in dev/test, the
  mailer logs the OTP at `warn` level. Look for
  `smtp_dev_mode_otp_logged` in the logs to recover it locally.

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

### Audit log archival

The `audit_log` table has `REVOKE UPDATE, DELETE, TRUNCATE FROM PUBLIC` (see
`apps/api/migrations/0004_audit.sql`) so it is append-only by application
users. A SECURITY DEFINER function `archive_audit_log(retention_days integer)`
moves rows older than `retention_days` into the `audit_log_archive` table
(added in migration `0007_audit_archival.sql`).

To run it manually (as the migration owner or an admin role):

```sql
SELECT archive_audit_log(365);   -- archive rows older than 1 year
```

Returns the number of rows moved.

Recommended cron schedule (run weekly, off-peak):

```
0 3 * * 0  psql "$DATABASE_URL" -c "SELECT archive_audit_log(365);"
```

Wire the schedule into your existing cron manager (k8s CronJob, systemd
timer, host crontab). The retention window is a policy decision; 365 days
is the project's default per HANDOFF §"Polish items pendientes" #4.

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
the dedicated idempotent CLI (cost-12 bcrypt hashes, same as
`AuthService`):

```bash
cd apps/api && npm run seed:e2e
```

This upserts the three default users — `admin@quorum.local`,
`operator@quorum.local`, `auditor@quorum.local` — with passwords
`admin1234`, `operator1234`, `auditor1234` (matching the defaults in
`apps/web/e2e/auth.spec.ts`). Each user is created if missing or
refreshed with a fresh bcrypt hash if already present.

This script is idempotent — running it multiple times upserts users
with fresh bcrypt hashes. Safe to re-run before each e2e test session.

Override any default via env vars before running the script:
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

## Production deployment with nginx

For VPS deployment with auto-TLS via Let's Encrypt, use the vhost in
`infra/nginx/quorum.asistentepro.mx.conf` and the operational guide in
`infra/nginx/README.md`. The README walks through:

1. Install nginx + certbot (`apt install nginx certbot python3-certbot-nginx`).
2. Build the app (`npm install && npm run build --workspaces --if-present`).
3. Drop env files into `/etc/quorum-backoffice/` (api.env + web.env).
4. Enable the systemd units (templates in `infra/nginx/README.md` §5).
5. Symlink `infra/nginx/quorum.asistentepro.mx.conf` into `/etc/nginx/sites-enabled/`.
6. Run `certbot --nginx -d quorum.asistentepro.mx` — TLS auto-provisioned.
7. `systemctl reload nginx` — done.

The vhost:
- HTTP→HTTPS redirect on port 80.
- TLS 1.2/1.3 only via Let's Encrypt (auto-renewal).
- Routes `/healthz`, `/readyz`, `/metrics` (CIDR-restricted) to the API.
- Routes `/api/*` to the API.
- Catch-all to the Next.js web (port 3002).
- Adds HSTS, X-Frame-Options DENY, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, X-XSS-Protection.
- `server_tokens off` (no nginx version leak).
- `_next/static/*` cached 1 year with immutable.

For production HTTPS mode in the api:
- `ALLOWED_ORIGIN=https://quorum.asistentepro.mx` — single-origin CORS allow.
- `AUTH_COOKIE_SECURE=true` — cookies only over HTTPS.
- `AUTH_COOKIE_NAME=__Host-sid` — cookie hardening (requires Secure + Path=/).
- `SESSION_SECRET` — generate fresh with `openssl rand -hex 32`.

The Quorum Backoffice is mounted at `/backoffice/` under the domain
because the root (`/`) hosts Jitsi. The Next.js app uses
`basePath: '/backoffice'` (in `apps/web/next.config.ts`) to auto-prefix
all internal links. Nginx uses `rewrite` directives to strip the
prefix when forwarding to the backend services, so the api continues
to serve at `/api/v1/...` internally and the web serves at `/...`
internally — the `/backoffice/` prefix exists only at the public
edge.

See `infra/nginx/README.md` for the full operational guide.
