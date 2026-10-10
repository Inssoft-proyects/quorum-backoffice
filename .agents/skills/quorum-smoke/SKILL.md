---
name: quorum-smoke
description: "Trigger: smoke test, post-deploy check, verify the ecosystem, health check all services. Verify Quorum logins, TLS per FQDN, nginx config and exposed ports."
license: Apache-2.0
metadata:
  author: inssoft-quorum
  version: "1.0"
---

## Activation Contract

Use after a deploy, before closing an incident, or on demand to confirm the Quorum
ecosystem is healthy end to end.

## Hard Rules

- Read-only. Never rotate credentials or change config from this skill.
- Never report a service green if it was not actually probed. Mark unknowns as unknown.

## Decision Gates

| Surface | Probe | Red flag |
| --- | --- | --- |
| TLS + health | `curl -sk -o /dev/null -w '%{http_code}' https://<fqdn>/...` | connection error, TLS mismatch, 5xx |
| Login | Backoffice / Monitor / OTP / Canvas login forms | login rejected (`invalid_*`) |
| nginx | `sudo nginx -t` | config error or warning |
| Ports | `ss -ltn` | unexpected public listeners |

## Execution Steps

1. FQDN health (expect 200/301/307 for HTML surfaces, 401/200 for `/api/v1/auth/me`):
   - `monitor.inecuni.com`, `backoffice.inecuni.com`, `otp.inecuni.com`, `lms.inecuni.com`,
     `quorum.inecuni.com`, `secret.inecuni.com`.
2. Login flow per consumer (see `/planQuorum/dev/e2e/` for the monitor; use the OTP skill for
   the Backoffice). A working login requires a valid `(subject, scope)` OTP.
3. `sudo nginx -t` (expect `syntax is ok` / `test is successful`).
4. `ss -ltn` and confirm only the intended ports are public.
5. Print a per-service green/red table; list anything not probed as `unknown`.

## Output Contract

- One table: surface, probe, observed, verdict (`green`/`red`/`unknown`).
- Direct quote of any failing probe.

## References

- `/planQuorum/dev/quorum-backoffice/scripts/smoke-post-deploy.sh`
- `/planQuorum/dev/quorum-otp/docs/OPERATIONS.md`
