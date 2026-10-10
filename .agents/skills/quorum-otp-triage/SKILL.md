---
name: quorum-otp-triage
description: "Trigger: OTP login fails, invalid_credentials, invalid_otp, Usuario o codigo incorrecto, scope mismatch, dynamic OTP rejected. Diagnose quorum-otp verify failures across any Quorum consumer and restore login."
license: Apache-2.0
metadata:
  author: inssoft-quorum
  version: "1.0"
---

## Activation Contract

Use when a dynamic-OTP login/verify is rejected in any Quorum consumer: Backoffice
(`backoffice.inecuni.com`), Monitor (`monitor.inecuni.com`), Canvas, or the MFA app.

## Hard Rules

- Read-only by default. Change production only with explicit user authorization.
- Never echo secrets. Read `/root/qgm-otp.env` via `sudo grep` and keep values in-process.
- Never enable `OTP_VERIFY_SKIP_SCOPE_MATCH` or rotate credentials without an explicit request.

## Decision Gates

| Provider outcome | Cause | Action |
| --- | --- | --- |
| `not_found` | minted `scope`/`subject` != verify `scope`/`subject` | compare both sides; align, or bypass with authorization |
| `rate_limited` | >10 verify/min per `(subject, scope)` | wait the 60s window; do not retry blindly |
| `locked` | 3 failed tries -> `(subject, scope)` locked 900s | wait it out, or use another subject |
| provider 401/403 | HMAC identity/secret misconfig on our side | check `OTP_SERVICE_TOKENS` for the service name |

## Execution Steps

1. Identify the consumer's expected identity and scope:
   - Backoffice: `LOGIN_OTP_SCOPE='login'`, HMAC service `quorum-backoffice`.
   - Monitor: `QGM_OTP_SCOPE` (deployed value `login`), service `quorum-global-monitor`.
   - The `/get/` page mints scope `self` by default (`src/routes/user-otp.ts`).
2. Read provider evidence on the host (`127.0.0.1:4200`):
   - `curl -s http://127.0.0.1:4200/metrics | grep otp_verify_total`
   - `psql -d quorum_otp -c "select subject,scope,status,attempts,issued_at from otps order by issued_at desc limit 12"`
3. Run the probe (`scripts/otp-probe.mjs`): mint, then verify same-scope and cross-scope.
   `200 {valid:true}` on the cross-scope leg proves the mismatch is the scope binding.
4. Read the bypass flag:
   `sudo k3s kubectl -n quorum-otp get cm quorum-otp-config -o jsonpath='{.data.OTP_VERIFY_SKIP_SCOPE_MATCH}'`.
5. Report root cause, evidence, the single recommended fix, and the rollback.

## Output Contract

- Root cause plus evidence (metrics delta and probe result).
- One fix: align the minting scope, or enable the bypass (authorized), or wait out the lockout.
- Rollback when a production flag changed.

## References

- `/planQuorum/dev/quorum-otp/docs/API.md` — verify contract.
- `/planQuorum/dev/odd/tasks/otp-skip-scope-match-prod-enable.md` — bypass enable + rollback.
