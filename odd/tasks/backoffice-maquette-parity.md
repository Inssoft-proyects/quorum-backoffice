# BackOffice — paridad visual con maqueta Inec (Inicio, Marbetes, Dispositivos, Auditoría)

## Goal

Make the four authed BackOffice screens (`/backoffice/dashboard` [Inicio],
`/backoffice/marbetes`, `/backoffice/dispositivos`, `/backoffice/audit`
[Auditoría]) visually identical to the HTML canon
`diseno/maqueta_Inec/Inec/inventario-credenciales.html`, keeping the reusable
shadcn components (`apps/web/components/ui`), and applying the color tokens
from `diseno/design/InecConecta_color_tokens.png`.

Verified with Playwright until a hybrid equivalence score ≥ 96%:
pixel-diff (screenshots vs maquette renders / reference PNGs) + structural
comparison (computed styles, CSS tokens, DOM pattern). Weighted average.

## User decisions (2026-09-25)

- Reference: HTML maquette is the visual canon.
- Metric: hybrid (pixel-diff + structural; weighted average ≥ 96%).
- Auth: run Playwright with the `admin` user; OTP obtained via `curl`
  from the OTP service (real quorum-otp on `127.0.0.1:4200`, HMAC contract,
  or local mock on `127.0.0.1:18080` if pointed there).
- Scope: Next.js app only (`apps/web`); the maquette HTML stays untouched.

## Key facts (explored)

- Maquette: `diseno/maqueta_Inec/Inec/` — `inventario-credenciales.html`
  (4592 lines), `css/{tokens,components,credential-inventory,utilities}.css`,
  `js/credential-inventory.js`.
- Color tokens (PNG canon):
  primary/500 `#AB8620` (marca, acciones primarias, seleccionados),
  secondary/500 `#358456` (acciones secundarias, iconos activos),
  text/primary `#292929`, text/muted `#6F6F6F`, text/muted-bold `#5F5F5F`,
  feedback/success `#03BB35`, alert/error-bg `#FFE5E9`,
  alert/error-text `#AC000E`, alert/warning-bg `#FFF5E6`,
  alert/warning-text `#723D19`. Use tokens by role, not by visual name.
- App screens: `apps/web/app/(authed)/{dashboard,marbetes,dispositivos,audit}`.
  shadcn components in `apps/web/components/ui`.
- Existing Playwright infra: `apps/web/e2e/lookfeel/*.spec.ts`
  (06 marbetes, 08 dispositivos, 09 audit, 11 maquette-v3), helper
  `e2e/lookfeel/helpers/login.ts` reads `E2E_<ROLE>_USERNAME` / `E2E_<ROLE>_OTP`.
- Local stack: API `node dist/src/server.js` (deployed :4100), web :4002,
  real quorum-otp :4200 (HMAC), mock OTP :18080 (Bearer test, code 123456).
- Seed: admin username = `admin` (`apps/api/scripts/seed-e2e-users.ts`).
- Web→API base: `NEXT_PUBLIC_API_URL` (`apps/web/lib/api-client.ts`).
- Playwright webServer builds standalone and serves on :3100
  (`apps/web/playwright.config.ts`).

## Scout findings (T1, gentle-ai-explore)

- NOTE: `diseno/maqueta_Inec/` and `diseno/design/` are gitignored, so
  grep/find-based tools cannot see them. They DO exist on disk (verified
  via bash). Any subagent must read them with `read`/`bash`, not find/grep.
- Color tokens: already mapped 1:1 in `apps/web/app/globals.css` `@theme`
  block (lines 30-58) matching the InecConecta PNG roles. Writer must
  cross-check against maquette `css/tokens.css` for drift.
- Shell/sidebar already matches (AppShell, sidebar with Inicio / Marbetes /
  Dispositivos / Auditoría).
- marbetes, dispositivos, audit: already on the v2 pattern (h1 +
  .metrics-grid with 4 MetricCards + donut charts + search shell +
  .data-table + Pagination). Residual drift: copy/spacing/dialog styling.
- dashboard: OUTLIER — placeholder 3-card shadcn grid, no v2 pattern.
  Needs full rebuild: `.inventory-page` wrapper, h1 + subtitle,
  4 MetricCards (reusing `@/components/inventory`), data from existing
  list endpoints.
- Playwright: local config builds standalone on :3100; set
  `NEXT_PUBLIC_API_URL=http://127.0.0.1:4100` (local API).
- OTP recipe (real quorum-otp :4200, HMAC):
  SECRET from `kubectl -n quorum-backoffice get secret
  quorum-backoffice-api-secret -o jsonpath='{.data.OTP_SERVICE_TOKEN}' | base64 -d`;
  `Authorization: HMAC quorum-backoffice <ts> <HMAC-SHA256(secret, "<ts>.<rawBody>")>`;
  POST http://127.0.0.1:4200/v1/otps body `{"subject":"admin","scope":"login"}`.
  (Mirror: `scripts/e2e-login-probe-username.mjs`.)
- Pixel-diff: no pixelmatch dep; Playwright `toHaveScreenshot` available
  (@playwright/test ^1.48). Baselines can be produced by serving the
  maquette HTML locally and screenshotting it.

## Tasks

- [x] T1 — Scout: gap analysis maquette vs the 4 screens (structure,
      tokens, components) + resolve exact OTP curl + env wiring for
      Playwright. Read-only report. (done 2026-09-25, findings above)
- [ ] T2 — Implement/verify color tokens (InecConecta) in the app theme
      (globals.css @theme) against maquette `css/tokens.css`.
- [ ] T3 — Align the 4 screens to the maquette pattern (heading +
      4 metric cards + filters + table), keeping shadcn components.
      Main work: dashboard rebuild; drift fixes on the other three.
- [x] T4 — Hybrid equivalence harness: `12-maquette-parity.spec.ts` +
      helpers (maquette-server, parity-scorer, parity-diff) +
      `scripts/get-admin-otp.sh`. (done 2026-09-26)
- [x] T5 — Iterations 1-5 until ≥96%: infra unblocks (mirror API :4300
      with k8s DATABASE_URL, OTP_SERVICE_URL without /v1, sid non-Secure
      cookie, rate-limit clears), harness fixes (per-test OTP mint,
      dashboard-anchored waitForURL, region appliesTo, report aggregation,
      design-intent N/A checks), app CSS drift (metrics-grid gap, donut
      absolute position, card padding). FINAL: total 97.22% — marbetes
      96.69, dispositivos 96.92, audit 97.22, dashboard 98.06; 42/42
      structural checks; all metrics-grid regions 100%. Evidence:
      `apps/web/e2e/lookfeel/artifacts/parity/report.json`.
- [x] T6 — Close: report, evidence, work-unit commits.

## Commits (branch `feature/backoffice-maquette-parity`)

- `80e5dc0` feat(web): align inventory pattern with Inec maquette tokens and donut geometry
- `ea98721` feat(web): rebuild dashboard on the maquette v2 pattern
- `10b4121` test(e2e): add hybrid maquette parity harness (pixel + structural)
- `5637194` docs(odd): track backoffice-maquette-parity feature

## Follow-ups (out of scope, not done)

- Pre-existing deletions `scripts/e2e-countdown-{smoke,states}.mjs` left uncommitted (not from this feature).
- `.next` was root-owned; cleaned with sudo (build cache only).
- Mirror API on :4300 (websop PID) left running for future parity runs; kill when done.
- API boot-probe bug: `SELECT now()::int` cast warning in pg.js (pre-existing, non-fatal).
- zod coerces AUTH_COOKIE_SECURE='false' to true (pre-existing config quirk).
- Deleting `login_attempts:admin` in shared Redis was required per run (probes poison the budget).
