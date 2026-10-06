# Mobile channel for the MFA endpoint

This document is the **mobile-facing contract** for
`POST /api/v1/mfa/authenticate`. It is the sister document to the
M1 plan; the M1 plan owns the design, this document owns the
shape the mobile app is allowed to depend on.

## Scope

The mobile app authenticates a student with three factors:

1. **Marbete code** — the physical security token (raw value, the
   API hashes it with sha256 at request time).
2. **Device serial** — the printed identifier on the device the
   student is using.
3. **Dynamic OTP** — a 6-character uppercase alphanumeric code
   pre-issued by the operator (out of band, via the
   `quorum-otp` service under the `mfa.access` scope).

On success the student gets a session. The mobile channel reuses
the same `POST /api/v1/mfa/authenticate` endpoint the web MFA
page uses — there is no separate mobile endpoint. The response is
already JSON (not HTML) and the cookie attributes are already
what a mobile WebView / CookieJar expects, so a sibling
`/authenticate.json` is **not** needed (M5.2 in the plan is
deferred — see [JWT option (deferred)](#jwt-option-deferred)).

## Endpoint

```
POST /api/v1/mfa/authenticate
Content-Type: application/json
```

### Request

```json
{
  "marbete_code":  "string (8..128 chars)",
  "serial_number": "string (3..128 chars)",
  "otp":           "string (6 chars, uppercase alphanumeric)"
}
```

The full bounds are encoded in the Zod DTO
`MfaAuthenticateRequest` in
[`packages/shared/src/dto/mfa.ts`](../../packages/shared/src/dto/mfa.ts).
A body that fails validation returns `400 validation_error` and
**never** reaches the deny taxonomy.

### Success response

`201 Created` with the JSON body below **and** a `Set-Cookie`
header carrying the `__Host-mfa_sid` session cookie (see
[Session cookie](#session-cookie)).

| Field           | Type            | Notes                                                                                     |
| --------------- | --------------- | ----------------------------------------------------------------------------------------- |
| `canvas_user_id` | number (int)    | The Canvas LMS user id. The session is keyed by this id.                                  |
| `student_name`   | string          | Denormalized for the first response so the client can render the success screen without a follow-up `GET /api/v1/mfa/session` call. |
| `student_email`  | string (email)  | Same rationale as `student_name`.                                                         |
| `role`           | `'student'`     | Always the literal string `'student'`. The MFA flow does NOT issue a BackOffice operator session. |
| `session_id`     | string          | The opaque session token. **Same value as the cookie**. A mobile client without a cookie store can use this value directly (see [Cookie-less mode](#cookie-less-mode)). |
| `expires_at`     | string (ISO 8601) | UTC instant the session expires. **String, not a `Date` object**, so the mobile JSON parser picks it up without a custom decoder. |

The full shape is encoded in the Zod DTO `MfaAuthenticateResponse`
in the same file.

## Session cookie

The endpoint sets a single `Set-Cookie` header on success:

```
Set-Cookie: __Host-mfa_sid=<session_id>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600
```

| Attribute       | Value     | Why                                                                                                                                                       |
| --------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name            | `__Host-mfa_sid` | The `__Host-` prefix forces `Secure` + `Path=/` + no `Domain` attribute. Browsers (and mobile WebViews) reject the cookie if any of those is missing. |
| `Path`          | `/`       | The cookie is sent on every API call under the API host.                                                                                                  |
| `HttpOnly`      | (flag)    | The cookie is not exposed to JavaScript — defense in depth against XSS in the mobile WebView.                                                            |
| `Secure`        | (flag)    | The cookie is only sent over HTTPS. The integration suite runs with `AUTH_COOKIE_SECURE=false` for the test env; production MUST set it to `true`.     |
| `SameSite`      | `Lax`     | The cookie is sent on top-level navigations from external sites (the Canvas SSO redirect); it is NOT sent on cross-site `POST`s (CSRF defense).        |
| `Max-Age`       | `3600`    | The TTL is `app.config.SESSION_TTL_SECONDS` (default `3600` = 1h). The M1 plan defers the operator's confirmation on the MFA-specific TTL; until that lands, the MFA session reuses the operator session TTL for symmetry. |

The cookie value (everything between the first `=` and the first
`;`) **is** `body.session_id`. A mobile app can use either one;
they are interchangeable.

## Cookie-less mode

A mobile native app that does not run inside a WebView (and
therefore cannot persist a `__Host-` cookie) can:

1. Read `body.session_id` from the JSON response.
2. Pass it as the cookie header on every subsequent API call:
   `Cookie: __Host-mfa_sid=<session_id>`.

The server-side session lookup keys on the cookie value, not on
the cookie name, so the same session row resolves either way. The
mobile app is responsible for storing `session_id` in its
secure keychain / Keystore.

## Content-Type

The response is `Content-Type: application/json` (no charset
suffix is required, but a server-side addition of `; charset=utf-8`
is permitted by the contract and MUST be treated as the same
media type by the mobile parser). The mobile integration test
locks the value byte-for-byte.

## Audit log

Every successful authentication writes one row to `audit_log`:

| Column         | Value                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------- |
| `action`       | `'student.mfa_authenticate'`                                                                |
| `actor_id`     | `'__mfa__'`                                                                                 |
| `entity_type`  | `'student'`                                                                                 |
| `entity_id`    | `String(canvas_user_id)`                                                                    |
| `ip`           | the request's `ip` (stored as INET)                                                        |
| `user_agent`   | the request's `user-agent` header                                                            |
| `after_jsonb`  | `{ outcome: 'ok', student_name, student_email, session_id: <first 8 chars of the token> }` |
| `otp_id`       | the `id` of the consumed OTP in `quorum-otp`                                                |

The audit row **never** contains the raw marbete code, the raw
serial, or the raw OTP — only the denormalized student name and
email. The denial rows write the deny code into
`after_jsonb.outcome` (e.g. `deny.marbete_unknown`).

The M1 integration suite already asserts the audit row; the
mobile test in
[`apps/api/test/integration/mfa-mobile.test.ts`](../test/integration/mfa-mobile.test.ts)
re-asserts the row as a defense-in-depth so a future "audit on
a different code path" regression is caught at the mobile layer
too.

## Cross-client independence

The session table has no per-client uniqueness constraint, so two
mobile clients can authenticate at the same time and get two
independent session rows. Each row carries the request's `ip` and
`user_agent` so an operator can attribute the session to its
caller. The mobile test asserts this end-to-end: two clients
(different IP + different user-agent) get two **different**
session cookies, and the `sessions` table contains two rows
keyed by the two distinct `session_id` values.

## JWT option (deferred)

M5.2 in the plan defines an optional
`POST /api/v1/mfa/authenticate.json` sibling endpoint that would
return a `mfa_token` JWT in the body instead of (or in addition
to) the `__Host-mfa_sid` cookie. That endpoint is **not
implemented** in this work unit. The decision is to defer until a
mobile consumer is on the runway that cannot store the cookie or
the cookie value (e.g. a watchOS companion, a server-to-server
daemon). When that surfaces, the JWT sibling will:

- return the same `MfaAuthenticateResponse` shape, plus a
  `mfa_token` field carrying a short-lived signed JWT;
- accept the JWT in an `Authorization: Bearer <token>` header
  (in addition to the cookie);
- reuse the same `kind='student'` session row; the JWT is a
  *transport* layer, the session is the *source of truth*.

Until then, the supported mobile path is the cookie-based
session described in [Session cookie](#session-cookie) (or the
[Cookie-less mode](#cookie-less-mode) variant).

## Cross-references

- Plan: [`odd/tasks/canvas-jitsi-mfa-authentication.md`](../../../odd/tasks/canvas-jitsi-mfa-authentication.md) (M5 section).
- Source: [`apps/api/src/routes/mfa.ts`](../src/routes/mfa.ts).
- Service: [`apps/api/src/services/mfa-authenticate-service.ts`](../src/services/mfa-authenticate-service.ts).
- DTO: [`packages/shared/src/dto/mfa.ts`](../../packages/shared/src/dto/mfa.ts).
- M1 integration tests: [`apps/api/test/integration/mfa-authenticate.test.ts`](../test/integration/mfa-authenticate.test.ts).
- M5 mobile contract test: [`apps/api/test/integration/mfa-mobile.test.ts`](../test/integration/mfa-mobile.test.ts).
- Sibling M3 SSO redirect flow: [`apps/api/src/routes/mfa-tokens.ts`](../src/routes/mfa-tokens.ts) (separate concern, only relevant when the MFA web page is the entry point).
