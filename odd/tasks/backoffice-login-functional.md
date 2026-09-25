# Backoffice login functional end-to-end (reverse-proxy + OTP service)

## Goal

Make `https://backoffice.quorum.asistentepro.mx/login` work AND the
`POST /api/v1/auth/login/request` succeed so a real user can complete
the email → OTP login flow. Two independent defects identified during
the 2026-09-25 reverse-proxy validation pass:

1. **nginx routing gap** — `/login` (without the `/backoffice`
   prefix) returns `404 Next.js _not-found`. The current nginx
   vhost only redirects the exact root `/` to `/backoffice/login`
   via `location = /`. Adding `location = /login` mirrors that.
2. **OTP service upstream dead** — `OTP_SERVICE_URL=http://127.0.0.1:18080/v1`
   in the active configMap points to a process that is the leftover
   `mock-otp-service.ts` (cwd=`/planQuorum/dev/quorum-backoffice/apps/api`,
   pid 875493). It accepts connections but is not a real quorum-otp
   server. Replacing it with the real `quorum-otp` binary is what
   closes the 503 `otp_issue_failed`.

## Authorization

User authorized 2026-09-25 (root session, not audit):

1. **Apply nginx change** (1 line in `backoffice.quorum.asistentepro.mx.conf`).
2. **Deploy real quorum-otp** (option 2a: from `/planQuorum/dev/quorum-otp/`).
3. **Track this work in an ODD feature file** (`odd/tasks/backoffice-login-functional.md`).

> "No pares hasta terminar." — full forward authorization.

The HANDOFF.md "Constraints duros" (no prod access, no cluster k8s
edits, no `../quorum-otp/` mods) was scoped to the prior audit
session. The new authorization supersedes those.

## Cluster / runtime facts (gathered 2026-09-25)

- Cluster k3s single-node `quorum` running on the same node as the
  VPS (`216.225.193.226`, k3s v1.31.4+k3s1). `kubectl` available from
  this session.
- Postgres 18 listens on `127.0.0.1:5432` (system service, NOT in
  cluster). DB `quorum_otp` already exists with tables
  `otp_audit`, `otps`, `schema_migrations` — migrations already
  applied. User: `websop` with `quorum_otp_dev` password.
- Redis 8 listens on `127.0.0.1:6379` (system service).
- The existing backoffice-api pod uses `hostNetwork: true` with a
  `hostPath` mount of `/opt/quorum-backoffice → /opt/qb` and image
  `node:22-bookworm-slim`. That's the deploy template to mirror for
  quorum-otp.
- `quorum-otp` repo exists at `/planQuorum/dev/quorum-otp/`, has
  compiled `dist/server.js`, no k8s manifests yet.
- `quorum-otp` listens on **port 4200** by convention (backoffice
  api = 4100, web = 4002, otp = 4200).
- The currently-deployed backoffice-api binary already has
  `OtpClient.issue()` (Polish WU v6) — verified in
  `/opt/quorum-backoffice/apps/api/dist/src/services/otp-client.js`.
- HMAC contract (verified in `apps/api/src/services/otp-client.ts`
  + `quorum-otp/src/plugins/auth.ts`):
  - Header: `Authorization: HMAC <name> <unix-timestamp> <hex>`
  - Sig:    `HMAC-SHA256(secret, "${ts}.${rawBody}")` (lowercase hex)
  - Body field on wire is `token`, NOT `code` (client translates).
  - quorum-otp reads `OTP_SERVICE_TOKENS` env, format
    `name:secret,name:secret` (parsed in `quorum-otp/src/config.ts`).
- Current configMap `quorum-backoffice-api-config` (active, NOT the
  `last-applied-configuration` annotation):
  - `OTP_SERVICE_URL=http://127.0.0.1:18080/v1` (placeholder)
  - `OTP_SERVICE_TOKEN=mock-bearer-token-for-local-testing-only-1234567890`
    (HMAC secret placeholder — needs replacement with a real secret)
  - `AUTH_LOGIN_MAX_ATTEMPTS=100`, `AUTH_LOGIN_WINDOW_SECONDS=60`
    (note: NOT the 5/900 mentioned in README; already relaxed)
  - `SMTP_FROM=no-reply@quorum.local` only — no SMTP_HOST/PORT/USER
    in configMap. Mailer falls back to logged delivery in dev (Polish
    WU v6 dev-mode fallback, see `mailer.ts` `createMailerForTest`).
- `SMTP_*` env vars are referenced by the `mailer` plugin in dist but
  NOT yet present in the active configMap → mailer takes the
  logged-fallback path. That is fine for staging functional validation
  (operator reads OTP from pod logs); production email delivery
  requires a follow-up.

## Tasks

### WU #1 — nginx `/login` redirect [XS]

- **File**: `infra/nginx/backoffice.quorum.asistentepro.mx.conf`.
- **Change**: add `location = /login { return 302 /backoffice/login; }`
  BEFORE the catch-all `location /`.
- **Validation**: `nginx -t` + `curl -I https://backoffice.quorum.asistentepro.mx/login`
  shows `302 → /backoffice/login`.
- **No code change**, no API or web rebuild.

### WU #2 — quorum-otp k8s deploy [L]

- **Repo**: `/planQuorum/dev/quorum-otp/`.
- **Step 1**: rsync to `/opt/quorum-otp` (same pattern as the
  backoffice deploy path: exclude `node_modules`, `.git`, `coverage`,
  `dist-test`, etc.).
- **Step 2**: copy compiled `dist/` from `/planQuorum/dev/quorum-otp/dist/`
  into the rsynced tree at `/opt/quorum-otp/dist/` (already compiled;
  do not rebuild unless `src/` was modified).
- **Step 3**: write `/etc/quorum-otp/otp.env` (mode 0600,
  root:quorum) with the env vars listed below.
- **Step 4**: add `infra/k3s/` to the quorum-otp repo with:
  - `namespace.yaml` — `quorum-otp` namespace + labels.
  - `secret.yaml` — `quorum-otp-secret` (DATABASE_URL, REDIS_URL,
    OTP_OPERATOR_SESSION_SECRET, OTP_OPERATOR_USERS, OTP_SERVICE_TOKENS).
    All values generated with `openssl rand` for the session secret
    and HMAC secrets. The OTP_SERVICE_TOKENS pair MUST match the
    secret the backoffice-api pod will use.
  - `configmap.yaml` — `quorum-otp-config` (PORT=4200, HOST=0.0.0.0,
    NODE_ENV=production, LOG_LEVEL=info, OTP_DEFAULT_*,
    OTP_RATE_*, OTP_LOCKOUT_*, OTP_HMAC_SKEW_SECONDS, OTP_UI_ENABLED=true,
    OTP_UI_HOST=0.0.0.0).
  - `deployment.yaml` — single-replica Deployment mirroring the
    backoffice-api pattern: image `node:22-bookworm-slim`,
    `hostNetwork: true`, `hostPath` mount
    `/opt/quorum-otp → /opt/qb-otp`, `workingDir=/opt/qb-otp`,
    command `["node", "dist/server.js"]`, ports 4200/TCP, probes
    `/healthz` (liveness) + `/readyz` (readiness).
  - `service.yaml` — `quorum-otp` ClusterIP on 4200 (so other
    consumers can resolve it; the backoffice-api will still use
    `127.0.0.1:4200` since it's also on hostNetwork).
  - `kustomization.yaml` — wires the five resources.
- **Step 5**: `kubectl apply -k infra/k3s/` from the quorum-otp repo.
- **Step 6**: wait for pod Ready (`kubectl -n quorum-otp wait pod -l
  app.kubernetes.io/name=quorum-otp --for=condition=Ready --timeout=60s`).
- **Validation**:
  - `curl -sS http://127.0.0.1:4200/healthz` → `200`.
  - `curl -sS http://127.0.0.1:4200/readyz` → `200 {"status":"ok",...}`.
  - `curl -sS http://127.0.0.1:4200/metrics` → `200` Prometheus text.
- **No code changes** to quorum-otp service itself.

### WU #3 — HMAC secret wire [S]

- **Generate**: `openssl rand -hex 32` → store as
  `OTP_HMAC_SECRET_BACKOFFICE`.
- **Wire quorum-otp side**: the `quorum-otp-secret` k8s Secret key
  `OTP_SERVICE_TOKENS` = `quorum-backoffice:$OTP_HMAC_SECRET_BACKOFFICE`.
- **Wire backoffice-api side**: the existing `quorum-backoffice-api-secret`
  k8s Secret key `OTP_SERVICE_TOKEN` is overwritten (not patched — full
  replace) with `$OTP_HMAC_SECRET_BACKOFFICE`. No raw value is committed.
- **Restart**: `kubectl -n quorum-backoffice rollout restart deploy
  quorum-backoffice-api` (after WU #4 changes configMap).
- **Validation**: see WU #5.

### WU #4 — API configMap OTP_SERVICE_URL [XS]

- **File**: kubectl patch against `quorum-backoffice-api-config` in
  namespace `quorum-backoffice`.
- **Change**: `OTP_SERVICE_URL` from
  `http://127.0.0.1:18080/v1` → `http://127.0.0.1:4200/v1`.
- **Restart**: `kubectl -n quorum-backoffice delete pod -l
  app.kubernetes.io/name=quorum-backoffice-api --force --grace-period=0`
  per the existing RUNBOOK pattern.
- **Validation**: pod Ready, `kubectl logs ... | grep OTP_SERVICE_URL`
  shows the new value (only in env-dump on boot, not in steady state).

### WU #5 — E2E validation with Playwright [S]

- **Script**: `/planQuorum/dev/quorum-backoffice/scripts/e2e-login-probe.mjs`
  (added by this WU). Headless chromium; reads the OTP from the API
  pod logs after the `POST /api/v1/auth/login/request`; submits the
  OTP into the second login step; asserts:
  1. `GET /login` → `302 → /backoffice/login` (WU #1).
  2. `GET /backoffice/login` → `200` with `LoginFormOtp`.
  3. `POST /api/v1/auth/login/request` (seeded email) → `200
     {"ok":true,...}` (WU #2 + #4 + #3 — the HMAC + upstream fix).
  4. OTP issued by quorum-otp visible in API logs (mailer fallback
     path).
  5. `POST /api/v1/auth/login` (with the OTP) → `200` + Set-Cookie
     `__Host-sid`.
  6. `GET /backoffice/dashboard` with the cookie → `200` (proves the
     session is real, not mocked).
- **Cleanup**: kill the headless browser, delete any test session rows
  in `quorum_backoffice.sessions` if a strict cleanup is required
  (skip — session TTL is short, non-issue).

## Constraints honored

- No destructive git ops on this repo.
- Each task ends with one work-unit commit on `feature/backoffice-login-functional`
  branch (created at WU #1 start, see RUNBOOK branch convention).
- Branch off `master` since that's the default branch here.
- Push to `origin` happens only after all WUs pass locally + cluster
  state is verified.
- No source files outside `quorum-otp/infra/k3s/` are touched in the
  quorum-otp repo (only new infra dir added; service source unchanged).
- The mock-otp-service.ts script (pid 875493, :18080) is left
  running — once `OTP_SERVICE_URL` flips to `:4200` it stops being
  the upstream. Killing it is a separate operator decision (other
  tests may use it).

## Operational note — OTP service maintenance windows

User-stated expectation (2026-09-25):

> "Si el servicio de OTP no está disponible, se debe a una ventana de
> mantenimiento, sólo espero 5 minutos y vuelve a intentar, gracias."

Interpretation:

- The `quorum-otp` service is expected to have **planned maintenance
  windows of ~5 minutes** during which the upstream URL may be
  unreachable or return 5xx.
- During such a window, end users of `backoffice.quorum.asistentepro.mx`
  who attempt email → OTP login should expect the login to fail and
  retry after ~5 minutes.
- This is the **expected operational behaviour**, not a defect of the
  backoffice or its reverse proxy.
- The backoffice's local rate-limit
  (`AUTH_LOGIN_MAX_ATTEMPTS=100`, `AUTH_LOGIN_WINDOW_SECONDS=60` per
  the active configMap; `LOGIN_OTP_REQUEST_MAX_PER_EMAIL=100`,
  `LOGIN_OTP_REQUEST_WINDOW_SECONDS=60` likewise) does NOT collide
  with a 5 min maintenance window — the limits are sized so that a
  user who retries once or twice across a 5 min window still has
  plenty of budget. If future tuning is needed (e.g. shrink the
  window to match a real outage), it must be done in coordination
  with quorum-otp's own rate-limit settings
  (`OTP_RATE_ISSUE_PER_SUBJECT_SCOPE`, `OTP_LOCKOUT_DURATION_SECONDS`).
- Future operator UI may want to surface "OTP service in maintenance,
  try again in a few minutes" instead of a generic 503 — tracked in
  follow-ups, not part of this feature.

## Out of scope (flagged for follow-up)

- SMTP real delivery (currently mailer logs OTPs to the API pod logs;
  staging UX is "operator reads the log"; production needs real SMTP).
- OTP operator UI exposure at a public hostname (currently only
  reachable inside the cluster; operator console works locally).
- Bulk provisioning of operator users (currently only `admin` seeded
  in `OTP_OPERATOR_USERS`).
- Healthz/readyz on the backoffice subdomain (currently 404 from
  Next.js catch-all; health probes remain on `quorum.asistentepro.mx`).

## Verification scope

This file tracks the deploy + validation. Re-runs against live
`https://backoffice.quorum.asistentepro.mx` are recorded as observations
in the commit messages of each WU.