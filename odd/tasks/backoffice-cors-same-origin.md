# BackOffice same-origin API routing and CORS repair

## Working-tree anchor (current audit)
- Branch: `master`, tracking `origin/master`. HEAD: `f2594836fa27e2e466039ea83126d93edf0fe0ad`.
- This task file and `infra/nginx/backoffice.quorum.asistentepro.mx.conf` sit **uncommitted** in the working tree (untracked). No staged files.
- Independent scope from the username + pre-issued OTP auth draft documented in `odd/tasks/backoffice-username-otp.md`; the two are tracked separately and neither alters the other.

## Goal
Serve the BackOffice on `https://backoffice.quorum.asistentepro.mx` and have its browser API calls use that same origin, avoiding the retired `quorum.asistentepro.mx/backoffice` path and browser CORS preflight failure.

## Evidence and constraints
- Browser preflight to `https://quorum.asistentepro.mx/backoffice/api/v1/auth/login` returned 405 from the Jitsi catch-all, with no CORS headers.
- Direct Fastify and post-deploy same-origin preflights return 204 with the expected `Access-Control-Allow-Origin`, credentials, POST method, and content-type headers.
- Web API client concatenates `NEXT_PUBLIC_API_URL` with request paths beginning `/api/v1`; the base URL must be the origin only (`https://backoffice.quorum.asistentepro.mx`), not a path suffix.
- API upstream is `quorum_backoffice_api_k8s` -> `127.0.0.1:4100`; web upstream is `quorum_backoffice_web_k8s` -> `127.0.0.1:4002`.
- Do not modify API/OTP/DB configuration, credentials, or API pods. Do not submit login without a designated test identity/mailbox.

## Tasks
1. **Update canonical routing/build config** — add `/api/` proxy to existing API upstream in the BackOffice vhost; update web env example to same-origin API base. **Done:** `infra/nginx/backoffice.quorum.asistentepro.mx.conf`, `apps/web/env.example`.
2. **Deploy nginx route** — install updated vhost, validate and reload. **Done:** rollback copy at `/tmp/backoffice.conf.pre-cors.20260924200459`; `nginx -t` successful (pre-existing duplicate `tester` warnings only); nginx active after reload. Same-origin preflight to `/api/v1/auth/login` returned 204 with ACAO/ACAC, POST and content-type allowed.
3. **Rebuild and deploy web bundle** — build with `NEXT_PUBLIC_API_URL=https://backoffice.quorum.asistentepro.mx`, stage safely, replace mounted standalone web artifacts with rollback copy available, and restart only web pod. **Done:** Next 16 production build and typecheck passed; browser chunks contain new origin and no old origin. Standalone backup retained at `/opt/qb/apps/web/.next/standalone.rollback-cors-20260924201109`; web Deployment rolled out with one Ready replica.
4. **Playwright verification** — verify same-origin login UI and API route without performing a real login. **Done:** root resolves to `/backoffice/login`, title correct, email visible, no page errors/CORS console errors. A synthetic Playwright route intercepted the login-request POST at `https://backoffice.quorum.asistentepro.mx/api/v1/auth/login/request`, fulfilled it locally, and proved same-origin UI transition to OTP step. The POST was not forwarded; no OTP was entered. Direct curl preflight returned 204 with matching CORS headers.

## Verification scope (current audit)
- The "Done:" markers in the task bodies above reflect work previously reported in this task log from the earlier session that created it (vhost install, `nginx -t`, web rebuild/deploy, real preflight 204, synthetic Playwright UI flow).
- This audit session did **not** re-query live production (`https://backoffice.quorum.asistentepro.mx`) to re-validate the CORS/reverse-proxy state. Items above remain **previously reported/validated, not re-verified now**.
- This task is independent of the auth draft in `odd/tasks/backoffice-username-otp.md`. Do not infer from the auth work that the reverse-proxy or CORS behavior was changed or reverted.

## Final status
- CORS routing and browser bundle are aligned to the BackOffice subdomain; the reported cross-origin preflight path is no longer used.
- Real API login/OTP delivery was intentionally not exercised; backend behavior beyond OPTIONS remains unverified.
- `/favicon.ico` returns 404 (unrelated to CORS). The Firefox screen-dimensions fingerprinting warning is browser privacy protection, not an application error.
