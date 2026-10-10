# E2E failure triage playbook

Use with the `quorum-e2e` skill after `node e2e/run-e2e.mjs`.

1. **Preflight failure (`vhost responded HTTP 301`)** — the suite is pointed at a retired
   host. Use the `inecuni.com` canon (`QGM_E2E_BASE_URL`/`QGM_E2E_HOST` or the config default).
2. **Run ~1.5m instead of ~25s, still green** — the provider verify rate limit (10/min per
   `(subject, scope)`) fired and the login helper backed off for the 60s window. Not a failure;
   do not "fix" it.
3. **`catalog-table` / `waitForURL` timeout, not rate-limited** — a real login/session problem.
   Triage with `quorum-otp-triage` (scope/subject/lockout).
4. **A write/audit test fails, a different one each run** — live-cluster/timing flakiness in the
   write surface, not the login. Re-run; if it persists on the same test, it is a regression.
5. **Missing issuer credentials** — `sudo grep -c '^OTP_SERVICE_' /root/qgm-otp.env` must be > 0;
   the runner needs passwordless sudo.

Suite facts: `01-auth` + `02-catalog` + `03-actions` = 14 tests; `workers: 1` (in-memory session
store); each spec logs in once (`beforeAll`) and reuses cookies; the login helper retries once
after a 60s backoff.
