# Canvas/Jitsi MFA authentication — marbete + device serial + dynamic OTP

## Objective and reason

A single MFA interface for frontends (mobile + Canvas interceptor) that
authenticates a student with three factors:

1. **Marbete code** — physical security token bound to a student via
   `marbetes.assigned_student_id`.
2. **Device serial** — the device the student is using, bound to the
   same student via `dispositivos.assigned_student_id`.
3. **Dynamic OTP** — a pre-issued code from the operator (the existing
   `POST /v1/operator/otps` flow in `quorum-otp`), scoped to
   `mfa.access` under the F4 allow-list.

The user identity and role are derived from the marbete: the marbete
points to a student in `students_cache`, the device must point to the
same student, and the session is a **student session** with
`canvas_user_id` + `role=student`. No new `users` rows, no new IdP.

This is the "always-shown interface" the user asked for: a single
page at `/mfa` on the backoffice web app, plus a JSON endpoint at
`POST /api/v1/mfa/authenticate` for the mobile channel and the
Canvas SSO redirect.

## User decisions (2026-10-04)

| Decision | Choice | Implication |
| --- | --- | --- |
| Identity model | Student session (`canvas_user_id` + `role=student`) | Same cookie shape as the backoffice user session, but keyed by `canvas_user_id`. No `users` row created. |
| OTP source | Pre-issued by the operator (existing model) | Reuses `POST /v1/operator/otps` in `quorum-otp`. Operator generates the OTP from the console, gives it to the student out-of-band. |
| Canvas integration | Canvas redirects to the MFA page (SSO-style) | Canvas detects missing session, redirects to `https://<backoffice>/mfa?next=<encoded>`. Backoffice authenticates, issues a one-time token, redirects to `next` with the token. Canvas calls a consume endpoint to validate the token and issue its own session. |

## Responsibility split across the Quorum suite

| Layer | Repo | Why |
| --- | --- | --- |
| OTP generation/verification | `quorum-otp` | Already owns the service, the scope allow-list, the OpenBao secret source. No duplication. |
| Marbete/device/student data | `quorum-backoffice-access` | Canonical schema. `marbetes`, `dispositivos`, `students_cache` live here. |
| MFA endpoint + student session | `quorum-backoffice-access` | Same domain as the session cookie. The `apps/api` already has the session infra (Redis-backed cookie, `requireSession`, `requireRole`). |
| MFA web page (`/mfa`) | `quorum-backoffice-access` | Same domain. The `apps/web` already has the `OtpInput`, `auth-context`, layout, and lookfeel helpers. |
| Token consume endpoint for Canvas | `quorum-backoffice-access` | Lives next to the issuer. Canvas calls it server-to-server (HMAC). |
| Canvas SSO redirect (interceptor) | `quorum-canvas` | T5 of the federated access plan. Small change: a redirect-on-no-session view. |
| Keycloak (alternative SSO path, password-based) | `quorum-canvas` (T3, not deployed) | Coexiste con MFA. Para usuarios sin marbete, password path sigue. Para usuarios con marbete, MFA lo reemplaza. |
| Observabilidad | `quorum-global-monitor` (post-M1) | MFA attempt counter, success rate, denial distribution. Not blocking. |

**No new service.** The MFA flow lives in `quorum-backoffice-access`
because that is where the data, the session, and the web app already
co-locate. A dedicated gateway would add a network hop and a new
secret without a clear v1 benefit.

## Tasks (stable IDs)

### M0 — Scope `mfa.access` in the OTP allow-list (quorum-otp)
- [ ] M0.1 Document the new scope in `docs/SECURITY.md` ("Per-service
      scope allow-list" section) with the rationale (marbete + device
      + OTP MFA flow).
- [ ] M0.2 No code change; the existing `OTP_SCOPE_ALLOW_LIST`
      mechanism already accepts any scope string. The allow-list is
      curated by the operator per the runbook
      `docs/secret-rotation-runbook.md`.
- [ ] M0.3 (Optional) Add a unit test that asserts the
      `parseScopeAllowList` + `check` cycle for
      `serviceName:mfa.access`.

### M1 — MFA endpoint + student session (quorum-backoffice-access)
- [ ] M1.1 DTO: `MfaAuthenticateRequest` (marbete_code, serial_number,
      otp) and `MfaAuthenticateResponse` (canvas_user_id, student_name,
      student_email, role='student', session_id, expires_at) in
      `packages/shared/src/dto/mfa.ts`.
- [ ] M1.2 Migration: extend the `sessions` table (or add a new
      `student_sessions` table) with `canvas_user_id` and `role`.
      Decision: reuse the existing `sessions` table with an
      additional `kind` column (`'user' | 'student'`) and a
      `canvas_user_id` nullable FK. This keeps the cookie shape
      identical and avoids a parallel session infra.
- [ ] M1.3 Service: `MfaAuthenticateService.authenticate({ marbete_code,
      serial_number, otp, ip, userAgent })`. Steps:
      1. Look up marbete by `code_hash` (the marbete code is hashed
         at rest; the input is hashed at request time and compared).
         Fail-closed: marbete not found, status != 'active',
         `deleted_at` IS NOT NULL → `deny.marbete_unknown`.
      2. Look up the marbete's student via
         `marbetes.assigned_student_id`. Fail-closed: no student or
         `is_active = false` → `deny.student_inactive`.
      3. Look up the device by `serial_number`. Fail-closed: device
         not found, status != 'active', `revoked_at` IS NOT NULL,
         `assigned_student_id` NULL or != student's id →
         `deny.device_unknown` /
         `deny.device_not_bound_to_student`.
      4. Verify the OTP via `OtpClient.verify` (existing, HMAC, with
         subject=`String(canvas_user_id)`, scope=`mfa.access`).
         Fail-closed: any non-2xx → `deny.otp_invalid` /
         `deny.otp_missing` / `deny.dependency_fail` (mirror the
         existing `AccessDecisionService` taxonomy).
      5. Issue a session: `kind='student'`, `canvas_user_id`,
         `role='student'`, TTL from config
         (e.g. `MFA_SESSION_TTL_SECONDS` default 3600).
      6. Return the session payload + the session cookie via
         `reply.setCookie` (same shape as the user session:
         `__Host-mfa_sid`, `HttpOnly`, `Secure`, `SameSite=Lax`,
         `Path=/`).
- [ ] M1.4 Route: `POST /api/v1/mfa/authenticate` (no preHandler; the
      MFA flow is itself the auth). Validates the body with
      `MfaAuthenticateRequest`, runs the service, sets the cookie,
      returns the response.
- [ ] M1.5 Tests: RED/GREEN. At least 12 cases (happy path, each
      failure mode, dependency fail, replay, concurrent attempts,
      session cookie attributes, audit row, denial taxonomy match).
- [ ] M1.6 Audit: write an `audit_action` enum entry
      `student.mfa_authenticate` and an `audit_log` row with the
      denial reason (or `ok`) and the canvas_user_id (never the
      marbete code, never the raw OTP).

### M2 — MFA web page (quorum-backoffice-access)
- [ ] M2.1 New page at `apps/web/app/mfa/page.tsx` and
      `apps/web/app/mfa/mfa-form.tsx`. Reads `?next=<encoded>` from
      the URL. Renders the title, the three-field form (marbete
      code, device serial, OTP), the submit button, and an
      inline error slot.
- [ ] M2.2 Reuses the existing `OtpInput` (alphanumeric mode, 6 boxes)
      and the `useAuth` context (extend it to handle a student
      session if needed; or add a parallel `useMfa` context).
- [ ] M2.3 On success: shows "Acceso concedido" with a primary
      button "Continuar" that links to the `next` URL with the
      redirect token (see M3). On failure: shows the typed error
      (mapping the denial taxonomy to a short message in the same
      style as `LoginFormOtp`).
- [ ] M2.4 Tests: unit (`mfa-form.test.tsx`) for form validation,
      error display, success navigation. Playwright e2e
      (`mfa.spec.ts`) for the full flow with a real operator-issued
      OTP against the running stack.

### M3 — SSO redirect token (quorum-backoffice-access)
- [ ] M3.1 Endpoint: `POST /api/v1/mfa/redirect-token` (HMAC
      preHandler, called by the MFA web page AFTER successful
      authentication). Takes `next_url` and the current student
      session cookie. Returns a one-time token
      (`mfa_redirect_token` Redis key) bound to the student identity
      and the `next_url` with a 30-second TTL. The MFA page
      constructs the URL `<next_url>?mfa_token=<token>` and
      navigates.
- [ ] M3.2 Endpoint: `POST /api/v1/mfa/consume` (HMAC preHandler,
      called by Canvas). Takes `token`. Validates the Redis key
      (`getdel` for atomicity), checks the `next_url` matches
      (constant-time string compare to prevent timing oracles),
      returns `{ canvas_user_id, student_name, student_email,
      role: 'student' }`. Deletes the key on success (one-time use).
- [ ] M3.3 Tests: RED/GREEN. Token TTL, one-time use, cross-domain
      binding (`next_url` must match the registered Canvas origin
      from a new config `MFA_ALLOWED_REDIRECT_ORIGINS`),
      constant-time compare, dependency fail on Redis outage.

### M4 — Canvas SSO interceptor (quorum-canvas)
- [ ] M4.1 New Django middleware or view decorator: on every
      authenticated-bearing request to Canvas, check the session.
      If absent, redirect to
      `https://<backoffice>/mfa?next=<urlencoded-current-path>`.
- [ ] M4.2 New endpoint in Canvas that handles the `?mfa_token=`
      query parameter: calls `POST /api/v1/mfa/consume` on
      backoffice (HMAC service-auth), receives the student identity,
      issues a Canvas session (Django session or JWT, per the
      existing Canvas auth model), and redirects to the original
      URL.
- [ ] M4.3 Tests: e2e against the running stack. Hard to write in
      isolation; the lookfeel suite is the natural home (add a
      spec under `apps/web/e2e/lookfeel/mfa-canvas.spec.ts` or the
      quorum-canvas equivalent).
- [ ] M4.4 Decision: this is a sibling-repo change. The work unit
      is owned by the canvas-jitsi-federated-access stream (T5).

### M5 — Mobile JSON endpoint (quorum-backoffice-access)
- [ ] M5.1 The `POST /api/v1/mfa/authenticate` endpoint already
      returns JSON; the mobile channel can call it directly. The
      mobile app stores the `__Host-mfa_sid` cookie in its
      WebView/CookieJar and uses it for subsequent API calls.
- [ ] M5.2 (Optional) If the mobile app needs a different response
      shape (e.g. a JWT instead of a cookie), add a sibling
      `POST /api/v1/mfa/authenticate.json` with the same semantics
      but a `mfa_token` field in the body. Decision: defer until a
      mobile consumer is on the runway.
- [ ] M5.3 Tests: a focused unit test asserting the mobile-friendly
      response shape is the same as the web (no extra endpoint yet).

### M6 — Observability (quorum-global-monitor, non-blocking)
- [ ] M6.1 Emit metrics from the MFA service: `mfa_attempt_total`
      (labels: outcome=ok|deny.marbete_unknown|deny.device_unknown|
      deny.otp_invalid|...), `mfa_session_ttl_seconds`,
      `mfa_consume_total` (labels: ok|expired|unknown_origin).
- [ ] M6.2 Wire the metrics into the QGM dashboard. Document in
      `quorum-global-monitor/odd/tasks/qgm-roadmap.md` if
      applicable.

## Cross-references

- Parent: `odd/tasks/canvas-jitsi-device-binding.md` (B1–B7 done).
- Sibling: `../quorum-canvas/odd/tasks/canvas-jitsi-federated-access.md`
  (T4 done in backoffice as B3; T5 = this plan's M4).
- OTP service: `../../quorum-otp/docs/secret-rotation-runbook.md` for
  the secret rotation; the `mfa.access` scope follows the same
  rollout model.
- Lookfeel helper: `apps/web/e2e/lookfeel/helpers/login.ts` is the
  reference for the segmented OTP input pattern; the MFA page
  reuses `OtpInput` (alphanumeric mode).

## Open decisions (decision checkpoints, not blockers)

1. **MFA session TTL**: 1h default (`MFA_SESSION_TTL_SECONDS=3600`)
   is a guess. Confirm with the operator (Canvas session lifetime is
   1d; matching might or might not be appropriate).
2. **`next_url` allowlist**: which Canvas origins are valid? Start
   with a single origin from `CANVAS_BASE_URL` config; expand if
   multiple Canvas environments (staging, prod) need the same flow.
3. **Mobile JWT vs cookie**: defer until a mobile consumer is on
   the runway (see M5.2).
4. **B5 SIS (matrícula) interaction**: the M1 endpoint reads
   `students_cache.canvas_user_id` and `is_active` (column
   `students_active` from migration 0006). B5 will replace this
   with the authoritative SIS source. The M1 contract does not
   change (still keyed by `canvas_user_id`); only the data
   source shifts.
5. **Keycloak coexistence**: T3 of the federated access plan adds
   Keycloak OIDC. If Keycloak ships first, the MFA flow must
   coexist (some users go through Keycloak, some through MFA).
   Decision: M4 redirects to MFA only when the user has a marbete
   bound; Keycloak handles password-only users. The detection
   happens at the Canvas side (a user pre-provisioned with a
   marbete is sent to MFA; otherwise to Keycloak). Operator
   decision.

## Verification / next step

Plan only. No code is written until the operator confirms direction
on the open decisions above. Once M0–M2 are approved, the bounded
work units follow the same RED/GREEN discipline as B1–B7 in the
parent task: small commits, one work-unit per commit, full suite
green before closing the unit, and the native review switch
honoured.
