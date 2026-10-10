---
name: quorum-e2e
description: "Trigger: run E2E, Playwright, regression suite, run the live suite. Run and triage the live Quorum Playwright E2E suite against the inecuni hosts."
license: Apache-2.0
metadata:
  author: inssoft-quorum
  version: "1.0"
---

## Activation Contract

Use to run or triage the live Quorum Playwright suite (auth, catalog, write/audit) that
targets the `monitor.inecuni.com` vhost and the host-loopback OTP issuer.

## Hard Rules

- Read-only against production except for the suite's own idempotent writes (capacity no-op,
  fixture-tenant restart/delete).
- Do not treat a flaky failure as a regression, or a rate-limit backoff as a product bug.
- Only the root suite at `/planQuorum/dev/e2e/` is the canonical live E2E.

## Decision Gates

| Symptom | Cause | Action |
| --- | --- | --- |
| preflight 301 | suite pointed at the legacy host | use the `inecuni.com` domain |
| `rate_limited` / 1.5m run | provider verify limit (10/min) | expected backoff; not a failure |
| `catalog-table` timeout and none of the above | real session/login regression | triage with the OTP skill |
| missing issuer credentials | `/root/qgm-otp.env` unreadable | run with passwordless sudo |

## Execution Steps

1. Preflight: `curl -sk -o /dev/null -w '%{http_code}' https://monitor.inecuni.com/api/v1/auth/me`
   (expect 401/200); confirm `sudo grep -c '^OTP_SERVICE_' /root/qgm-otp.env` > 0; browsers in
   `~/.cache/ms-playwright`.
2. Run: `cd /planQuorum/dev && node e2e/run-e2e.mjs`.
3. Triage each failure: rate-limit backoff vs real regression; cross-check K1 for login failures.
4. Report pass/fail counts, the resolved domain/scope profile, and the triage of any failure.

## Output Contract

- `N passed / M failed`, exit code, and the domain + OTP scope the suite minted.
- For each failure: root cause and whether it is flaky or a regression.

## References

- `/planQuorum/dev/e2e/run-e2e.mjs`, `/planQuorum/dev/playwright.config.mjs`
- `/planQuorum/dev/e2e/_helpers/login.mjs` (rate-limit-tolerant login)
