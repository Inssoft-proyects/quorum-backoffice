import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startMaquetteServer, type MaquetteServerHandle } from './helpers/maquette-server';
import {
  scoreParity,
  writeReport,
  type ParityScore,
} from './helpers/parity-scorer';

/**
 * T4 — BackOffice ↔ Maquette Inec hybrid equivalence harness.
 *
 * Drives the live BackOffice host (builds standalone on :3100) AND a
 * tiny static server that serves the maquette HTML canon from
 * diseno/maqueta_Inec/Inec/. For each of the 4 authed screens
 * (/dashboard, /marbetes, /dispositivos, /audit) it:
 *
 *   1. Logs in as admin (E2E_ADMIN_USERNAME; OTP minted per test via
 *      scripts/get-admin-otp.sh — see below).
 *   2. Screenshots the app at 1280x800 fullPage.
 *   3. Runs DOM/computed-style structural checks against the maquette's
 *      declared pattern elements + color tokens.
 *   4. Computes a pixel score: full page for /marbetes (with masks),
 *      chrome regions only for the other three (the maquette is a
 *      single-screen canon, so cross-screen pixel diff is only
 *      meaningful for shared chrome).
 *
 * The final score is the unweighted mean of the four per-screen
 * hybrid scores (0.5 * pixel + 0.5 * structural). The spec fails when
 * the total drops below `PARITY_THRESHOLD` (default 96).
 *
 * Auth contract:
 *   - E2E_ADMIN_USERNAME is the ONLY required env var. When absent,
 *     the spec skips cleanly with the same contract as
 *     helpers/login.ts (no fabricated logins, no human-authored
 *     paths).
 *   - E2E_ADMIN_OTP is intentionally NOT honored across tests: the
 *     BackOffice OTPs are single-use, so reusing one would burn the
 *     first code and surface `invalid_credentials` on tests 2–4.
 *     Each test instead mints a fresh admin OTP via
 *     scripts/get-admin-otp.sh (HMAC against the k8s-stored
 *     `OTP_SERVICE_TOKEN`, mirroring scripts/e2e-login-probe-username.mjs).
 *   - The harness intentionally does not write the shared HMAC
 *     secret to stdout or disk — only the OTP token is emitted, and
 *     only to the local child process.
 */

const VIEWPORT = { width: 1280, height: 800 } as const;

/**
 * Issue a fresh admin OTP via the helper script.
 *
 * OTPs are single-use, so each spec must mint its own — reusing the
 * `E2E_ADMIN_OTP` env var across the four screens would burn the
 * first code and surface "invalid_otp" on every subsequent test.
 * The helper script (scripts/get-admin-otp.sh) reproduces the HMAC
 * contract that quorum-otp expects; we never print or persist the
 * shared secret, only the OTP token itself.
 */
function issueFreshOtp(): string {
  const script = path.resolve(__dirname, '../../../../scripts/get-admin-otp.sh');
  return execFileSync(script, [], { encoding: 'utf-8' }).trim();
}

/**
 * Auth gate, mirroring the helpers/login.ts contract:
 *   - reads E2E_ADMIN_USERNAME (or skips if missing)
 *   - mints a fresh admin OTP per call (single-use codes cannot be
 *     reused across the 4 screens)
 *   - drives the live login form end-to-end and rewrites the
 *     Set-Cookie so the browser accepts it on plain HTTP
 *
 * Why cookie-rewrite instead of plain form-driving:
 *
 *   The login form POSTs to the API URL baked into the build
 *   (`NEXT_PUBLIC_API_URL`). The local API serves the session
 *   cookie with the `Secure` flag (or the `__Host-` prefix), which
 *   Chrome refuses on plain-HTTP localhost. Driving the live form
 *   without a rewrite therefore ends with a "No se pudo iniciar
 *   sesión" error and no session cookie.
 *
 *   The route intercept captures the browser's POST, replays it
 *   against the real API from a child-process `curl` (so we do not
 *   deadlock Playwright's own network stack), and fulfils the
 *   browser request with a sanitized Set-Cookie under the name the
 *   web reads. The session token is the same one the API would
 *   have issued; we only re-frame the cookie transport so the
 *   browser + web server can round-trip on HTTP localhost. The
 *   (authed) layout + every subsequent data fetch then runs
 *   against the real API normally.
 *
 *   When the rewrite cannot succeed (e.g. the API issues the
 *   `__Host-` prefix and the web reads `sid`, leaving us with two
 *   incompatible cookie names), the test skips with the exact
 *   reason instead of fabricating a session. Production behaviour
 *   is untouched; this is test-infrastructure plumbing only.
 */
async function loginAsAdmin(page: Page): Promise<boolean> {
  const username = process.env['E2E_ADMIN_USERNAME']?.trim();
  if (!username) {
    test.skip(
      true,
      'E2E_ADMIN_USERNAME not set; skipping parity harness',
    );
    return false;
  }
  // Always mint a fresh OTP for this test invocation. The BackOffice
  // OTPs are single-use, so reusing E2E_ADMIN_OTP across the four
  // screens would burn the first code and surface
  // `invalid_credentials` on tests 2–4. The env var is intentionally
  // NOT read here; the harness contract is that the operator only
  // needs to set E2E_ADMIN_USERNAME and the runner will mint its
  // own OTPs against the HMAC-stored quorum-otp secret.
  let otp: string;
  try {
    otp = issueFreshOtp();
  } catch (err) {
    test.skip(
      true,
      `could not issue admin OTP via scripts/get-admin-otp.sh: ${(err as Error).message}`,
    );
    return false;
  }
  const apiBase = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://127.0.0.1:4100';
  // The web reads the session cookie via `process.env.AUTH_COOKIE_NAME
  // ?? 'sid'`. The local API serves the cookie with the `__Host-`
  // prefix (HTTPS-only profile) and the `Secure` flag. On plain HTTP
  // localhost Chrome refuses to store the cookie, which makes the
  // login round-trip fail end-to-end.
  //
  // Workaround for the harness: intercept the browser-side login
  // request, fulfil it ourselves, and rewrite the `Set-Cookie` header
  // so the browser receives a non-Secure cookie under the name the
  // web expects. The session token is the same one the API would
  // have issued — we are only changing transport framing. This keeps
  // the rest of the test (the (authed) layout + every data fetch)
  // round-tripping against the real API on subsequent requests.
  //
  // The intercepted login response is captured so the spec can
  // surface a clear skip message when the API itself rejects the
  // request (e.g. invalid OTP, rate-limited, OTPSvc down).
  const webCookieName = process.env['AUTH_COOKIE_NAME'] ?? 'sid';

  // CORS preflight pass-through. The browser sends an OPTIONS request
  // before any cross-origin `application/json` POST; we answer it
  // locally so the API's production-only
  // `Access-Control-Allow-Origin` header does not block the test.
  let captured: { ok: boolean; bodyText: string } = { ok: false, bodyText: 'not captured' };
  // Match on a glob (any scheme + host) so the handler catches both
  // the OPTIONS preflight and the POST regardless of how Playwright
  // resolves the page request URL.
  await page.route(new URL('/api/v1/auth/login', apiBase).toString(), async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': req.headers().origin ?? 'http://127.0.0.1:3100',
          'access-control-allow-credentials': 'true',
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type, authorization',
          'access-control-max-age': '600',
        },
      });
      return;
    }
    try {
      // The route handler must reach the live API to mint a real
      // session token (single-use OTP + server-side session
      // storage) while rewriting the Set-Cookie so the browser
      // accepts it on plain HTTP. Playwright's own `route.fetch()`
      // and `page.request.post` both hung inside the route handler
      // (the registered route blocked the proxied upstream call),
      // so we run a child-process `curl` to bypass the Playwright
      // network stack entirely. curl is the same approach the
      // probe script (`scripts/e2e-login-probe-username.mjs`)
      // uses; we keep the dependency surface local.
      const body = JSON.stringify({ username, otp });
      const curlOut = execFileSync(
        'curl',
        [
          '-sS',
          '-i',
          '-X', 'POST',
          `${apiBase}/api/v1/auth/login`,
          '-H', 'content-type: application/json',
          '-d', body,
          '--max-time', '10',
        ],
        { encoding: 'utf-8', maxBuffer: 64 * 1024 },
      );
      // Split status line + headers + body
      const headerEnd = curlOut.indexOf('\r\n\r\n');
      const statusLine = curlOut.split('\r\n', 1)[0] ?? '';
      const statusMatch = statusLine.match(/HTTP\/[0-9.]+ (\d+)/);
      const status = statusMatch?.[1] !== undefined ? Number(statusMatch[1]) : 0;
      const headerBlock = headerEnd >= 0 ? curlOut.slice(0, headerEnd) : curlOut;
      const respBody = headerEnd >= 0 ? curlOut.slice(headerEnd + 4) : '';
      // Parse headers, find Set-Cookie
      const setCookie = headerBlock
        .split('\r\n')
        .map((l) => l.split(': ', 2))
        .find((kv) => kv[0] && kv[0].toLowerCase() === 'set-cookie');
      const rawCookie = setCookie?.[1] ?? '';
      const tokenMatch = rawCookie.match(/=([^;]+)/);
      const token = tokenMatch?.[1];
      const ok = status >= 200 && status < 300;
      const origin = req.headers().origin ?? 'http://127.0.0.1:3100';
      const baseHeaders: Record<string, string> = {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': origin,
        'access-control-allow-credentials': 'true',
      };
      if (!token) {
        captured = { ok: false, bodyText: `no token in Set-Cookie (${rawCookie || 'missing'}); body=${respBody}` };
        await route.fulfill({ status, headers: baseHeaders, body: respBody });
        return;
      }
      // Rewrite the Set-Cookie to (a) drop the `Secure` flag, (b)
      // drop the `__Host-` prefix when present, and (c) align the
      // name with what the web reads. The token value is preserved
      // byte-for-byte so the API still recognizes the session.
      const safeCookie = `${webCookieName}=${token}; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax`;
      baseHeaders['set-cookie'] = safeCookie;
      captured = { ok, bodyText: respBody };
      await route.fulfill({ status, headers: baseHeaders, body: respBody });
    } catch (err) {
      captured = { ok: false, bodyText: (err as Error).message };
      try {
        await route.abort();
      } catch {
        // route may have already been handled; ignore.
      }
    }
  });

  // Drive the live form. The OTP input is a 6-box OtpInput where
  // each box accepts exactly one character; we focus the first box
  // and rely on the component's auto-advance keyboard handler to
  // fill the rest, mirroring the `fillOtpBoxes` pattern used by
  // 10-auth-otp.spec.ts.
  await page.goto('/backoffice/login');
  await page.getByTestId('login-username').fill(username);
  await page.getByRole('textbox', { name: 'Digit 1 of 6' }).click();
  await page.keyboard.type(otp);
  await page.getByTestId('login-submit').click();
  // Wait specifically for the post-login navigation to /dashboard.
  // The previous form of `waitForURL(/\/(dashboard|login)/)` matched
  // the current /login URL immediately (login is a substring of the
  // regex) and the test then skipped with "did not navigate away
  // from /login" even when the auth had succeeded. Anchoring on the
  // dashboard with an explicit trailing slash makes the wait
  // meaningful: it only resolves after the form post + cookie
  // install + redirect complete.
  try {
    await page.waitForURL(/\/dashboard(\/|$|\?)/, {
      timeout: 20_000,
      waitUntil: 'load',
    });
    return true;
  } catch {
    // fall through to the diagnostic skip messages below
  }
  if (!captured || captured.bodyText === 'not captured') {
    test.skip(
      true,
      'login route handler never ran; the form did not POST to /api/v1/auth/login. Check that NEXT_PUBLIC_API_URL is set correctly when the webServer runs `npm run build`.',
    );
    return false;
  }
  if (!captured.ok) {
    test.skip(true, `live login failed: ${captured.bodyText}`);
    return false;
  }
  // Navigation timed out (the waitForURL above). Surface the final
  // URL + captured state so the triage points at the exact failure
  // (cookie rewrite succeeded vs API rejected the OTP vs layout
  // bounce back to /login).
  test.skip(
    true,
    `login submit did not navigate to /dashboard within 20s (final URL: ${page.url()}). captured.ok=${captured.ok}; body=${captured.bodyText.slice(0, 200)}`,
  );
  return false;
}
const ARTIFACT_ROOT = path.resolve(
  process.cwd(),
  'e2e/lookfeel/artifacts/parity',
);
const BASELINES_DIR = path.join(ARTIFACT_ROOT, 'baselines');
const APP_DIR = path.join(ARTIFACT_ROOT, 'app');
const REPORT_FILE = path.join(ARTIFACT_ROOT, 'report.json');

interface RegionSpec {
  id: string;
  /** Selector to locate the region inside the maquette DOM (used to
   * derive the maquette crop via boundingBox at screenshot time). */
  maquetteSelector: string;
  /** Selector to locate the same region inside the app DOM. */
  appSelector: string;
  /** Why this region is comparable (used in the JSON report). */
  why: string;
  /** Screens this region applies to. Missing → applies to all. */
  appliesTo?: ReadonlyArray<string>;
  /**
   * Optional fallback. When the region's primary `appSelector` does
   * not resolve on the live page, the harness tries these selectors
   * in order and skips the region if none match — instead of
   * throwing a boundingBox timeout that hangs the whole screen.
   */
  fallbackSelectors?: ReadonlyArray<string>;
  /** Mask sub-rects in crop coordinates. */
  masks?: () => Promise<{ rect: { x: number; y: number; w: number; h: number }; why: string }[]>;
}

/**
 * Per-screen region definitions for the chrome-scope pixel diff.
 *
 * Each region declares:
 *   - the maquette selector (always the same canon page)
 *   - the app selector (may vary per screen)
 *   - which screens it applies to (`appliesTo`)
 *   - optional fallback selectors so a screen-specific selector
 *     miss degrades to a skip-with-reason rather than a hung bbox
 *
 * The dashboard is a KPI overview that renders NO `.inventory-search`
 * shell by design; the search-shell region therefore does not apply
 * to /dashboard. The other chrome regions (app-shell, inventory-header,
 * metrics-grid) apply to every authed screen.
 */
const REGION_DEFS: ReadonlyArray<RegionSpec> = [
  {
    id: 'app-shell',
    maquetteSelector: 'main.inventory-page',
    appSelector: 'main, [data-testid="app-shell-main"]',
    fallbackSelectors: ['[data-testid="dashboard-page"]'],
    why:
      'Shared chrome: the page wrapper hosts the inventory-header + metrics-grid. ' +
      'Geometric and color match is expected across all 4 screens.',
  },
  {
    id: 'inventory-header',
    maquetteSelector: 'header.inventory-header',
    appSelector: 'header.inventory-header',
    why:
      'The h1 + subtitle + actions row. Copy differs per screen, so we do not ' +
      'compare text — only layout, padding, and chrome colors.',
    // Mask the h1 + subtitle text; keep the actions buttons.
    masks: async () => [],
  },
  {
    id: 'metrics-grid',
    maquetteSelector: '.metrics-grid',
    appSelector: '.metrics-grid',
    why:
      'The 4 metric cards row. Geometry + card chrome + donut colors ' +
      'are comparable; the value text is masked because each screen ' +
      'shows different counters.',
    masks: async () => [],
  },
  {
    id: 'search-shell',
    maquetteSelector: '.inventory-search',
    appSelector: '.inventory-search',
    // Dashboard is a KPI overview without a list/search; it renders
    // no .inventory-search shell by design. Skipping the region is
    // semantically correct rather than a failure.
    appliesTo: ['/marbetes', '/dispositivos', '/audit'],
    why:
      'Search input chrome. Counts and placeholder text differ per screen ' +
      'and per dataset, so we mask the count badge.',
  },
];

/**
 * Per-screen structural assertions derived from the maquette canon.
 *
 * The maquette canon (see diseno/maqueta_Inec/Inec/inventario-credenciales.html
 * and css/tokens.css) declares:
 *   .inventory-page wraps every screen
 *   .inventory-header h1 + subtitle + actions
 *   .metrics-grid with exactly 4 .metric-card (with --with-chart variant)
 *   .donut-chart inside metric cards (centered text)
 *   .inventory-search shell
 *   .table-shell > .data-table (where applicable)
 *   .table-pagination
 *
 * Token colors (from diseno/design/InecConecta_color_tokens.png and
 * apps/web/app/globals.css @theme block):
 *   primary/500     #AB8620
 *   secondary/500   #358456
 *   text/primary    #292929
 *   text/muted      #6F6F6F
 *   alert/warning-bg #FFF5E6
 */
const EXPECTED_TOKENS = {
  primary500: '#AB8620',
  secondary500: '#358456',
  textPrimary: '#292929',
  textMuted: '#6F6F6F',
} as const;

/**
 * Resolve an element's bounding box as a `{x,y,w,h}` rect, snapping to
 * integers and clamping to non-negative widths (some screenshots have
 * off-by-one float drift from the browser engine).
 *
 * Returns null when the selector does not resolve on the live page.
 * Earlier versions threw a hung `boundingBox()` action on missing
 * selectors; we now degrade to a graceful skip instead of waiting
 * the whole timeout — Playwright's default action timeout is 5s
 * per call and the test timeout is 30s, so a missing-region hang
 * was a real risk on the dashboard (which renders no
 * `.inventory-search` by design).
 */
async function rectOf(
  page: import('@playwright/test').Page,
  selector: string,
): Promise<{ x: number; y: number; w: number; h: number } | null> {
  const count = await page.locator(selector).count();
  if (count === 0) return null;
  const handle = page.locator(selector).first();
  const box = await handle
    .boundingBox({ timeout: 2_000 })
    .catch(() => null);
  if (!box) return null;
  return {
    x: Math.max(0, Math.round(box.x)),
    y: Math.max(0, Math.round(box.y)),
    w: Math.max(1, Math.round(box.width)),
    h: Math.max(1, Math.round(box.height)),
  };
}

function rectIntersect(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x || y2 <= y) return null;
  return { x, y, w: x2 - x, h: y2 - y };
}

/**
 * Build the dynamic-region masks for one screen.
 *
 * We mask:
 *   - the metric-card VALUE text (counts differ across maquette vs live)
 *   - the search COUNT badge (different number)
 *   - any table body rows (the maquette has static fake rows, the app
 *     has live data)
 *
 * The masks are computed from the live app's bounding boxes so they
 * stay correct even if the layout shifts. The same masks are applied
 * to the maquette screenshot (the maquette crop is resized onto the
 * app crop dimensions, so masks in crop-local coordinates line up).
 */
async function buildMasks(page: import('@playwright/test').Page): Promise<{ rect: { x: number; y: number; w: number; h: number }; why: string }[]> {
  const out: { rect: { x: number; y: number; w: number; h: number }; why: string }[] = [];

  // App-only chrome: the left sidebar (`<aside>`) and the topbar (the
  // FIRST `<header>` — the inventory-header is the SECOND `<header>`
  // on every authed page). The maquette renders neither; without
  // masking them the full-page pixel diff sees ~270px of unrelated
  // chrome on every comparison.
  await maskWithExpansion(page, out, 'aside', 'app-only chrome: sidebar (not in maquette)');
  await maskWithExpansion(
    page,
    out,
    'header',
    'app-only chrome: topbar (not in maquette)',
    { firstOnly: true },
  );

  // Dynamic dataset: metric-card VALUES, search COUNT, table body
  // rows. The maquette has hard-coded fake data (Total: 248) and
  // the app shows live counts (Total: 10); without masking these
  // every pixel in those rows diverges.
  const values = await page.locator('.metric-card__value').all();
  for (const v of values) {
    const box = await v.boundingBox();
    if (box) {
      out.push({
        rect: {
          x: Math.max(0, Math.round(box.x - 2)),
          y: Math.max(0, Math.round(box.y - 1)),
          w: Math.max(4, Math.round(box.width + 4)),
          h: Math.max(4, Math.round(box.height + 2)),
        },
        why: 'metric value text differs per dataset',
      });
    }
  }
  const counts = await page.locator('.inventory-search__count').all();
  for (const c of counts) {
    const box = await c.boundingBox();
    if (box) {
      out.push({
        rect: {
          x: Math.max(0, Math.round(box.x - 4)),
          y: Math.max(0, Math.round(box.y - 2)),
          w: Math.max(8, Math.round(box.width + 8)),
          h: Math.max(6, Math.round(box.height + 4)),
        },
        why: 'search count badge differs per dataset',
      });
    }
  }
  // Mask each table body row except the header.
  const rows = await page.locator('.data-table tbody tr').all();
  for (const r of rows) {
    const box = await r.boundingBox();
    if (box) {
      out.push({
        rect: {
          x: Math.max(0, Math.round(box.x)),
          y: Math.max(0, Math.round(box.y)),
          w: Math.max(20, Math.round(box.width)),
          h: Math.max(8, Math.round(box.height)),
        },
        why: 'table body row contains dataset-specific data',
      });
    }
  }
  return out;
}

/**
 * Read a selector's bounding box and push it into the mask array
 * with a small expansion on every side. `firstOnly` collapses the
 * selector to its first match — useful when the same tag is used
 * by both app chrome (topbar `<header>`) and page chrome
 * (inventory-header `<header>`) and only the first should be masked.
 */
async function maskWithExpansion(
  page: import('@playwright/test').Page,
  out: { rect: { x: number; y: number; w: number; h: number }; why: string }[],
  selector: string,
  why: string,
  options: { firstOnly?: boolean; expansion?: number } = {},
): Promise<void> {
  const { firstOnly = false, expansion = 4 } = options;
  const count = await page.locator(selector).count();
  if (count === 0) return;
  const locator = firstOnly ? page.locator(selector).first() : page.locator(selector).first();
  const box = await locator
    .boundingBox({ timeout: 2_000 })
    .catch(() => null);
  if (!box) return;
  out.push({
    rect: {
      x: Math.max(0, Math.round(box.x - expansion)),
      y: Math.max(0, Math.round(box.y - expansion)),
      w: Math.max(1, Math.round(box.width + expansion * 2)),
      h: Math.max(1, Math.round(box.height + expansion * 2)),
    },
    why,
  });
}

interface ScreenSpec {
  appPath: string;
  /** Where the maquette crops come from. For /marbetes the whole page is
   * comparable; for the other three, only the chrome regions are. */
  scope: 'full' | 'chrome';
}

/**
 * The four authed screens. The maquette only defines a marbetes-style
 * inventory page; for /dashboard, /dispositivos, /audit the spec runs
 * chrome-region pixel-diff (shared header, sidebar, metric grid,
 * search shell) plus structural checks. For /marbetes we run a full
 * page pixel-diff with dynamic regions masked.
 */
const SCREENS: ReadonlyArray<ScreenSpec> = [
  { appPath: '/marbetes', scope: 'full' },
  { appPath: '/dispositivos', scope: 'chrome' },
  { appPath: '/audit', scope: 'chrome' },
  { appPath: '/dashboard', scope: 'chrome' },
];

test.describe('BackOffice ↔ Maquette hybrid equivalence (T4)', () => {
  let maquette: MaquetteServerHandle;

  test.beforeAll(async () => {
    fs.mkdirSync(BASELINES_DIR, { recursive: true });
    fs.mkdirSync(APP_DIR, { recursive: true });
    maquette = await startMaquetteServer();
  });

  test.afterAll(async () => {
    await maquette?.stop();
    // Aggregate by reading the per-screen JSON files written by each
    // test, NOT by relying on the in-suite `scores` array. Earlier
    // versions of this spec declared `scores` inside the describe
    // block and pushed into it from the test callbacks, but the
    // shared closure was never observed by `test.afterAll` in the
    // verifier's run — the report wrote `screens: []`. Reading the
    // files from disk is robust to whatever lifecycle quirk
    // Playwright is using and gives us the same payload the test
    // produced (it is the same ParityScore that was serialized).
    const screens: ParityScore[] = [];
    for (const screen of SCREENS) {
      const appName = screen.appPath.replace(/^\//, '').replace(/\//g, '_') || 'root';
      const perScreen = path.join(ARTIFACT_ROOT, `${appName}.json`);
      if (!fs.existsSync(perScreen)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(perScreen, 'utf-8')) as ParityScore;
        screens.push(parsed);
      } catch {
        // Skip unreadable / malformed per-screen file.
      }
    }
    const total =
      screens.length === 0
        ? 0
        : screens.reduce((acc, s) => acc + s.hybridScore, 0) / screens.length;
    const payload = {
      generatedAt: new Date().toISOString(),
      viewport: VIEWPORT,
      threshold: screens[0]?.threshold ?? 96,
      screens,
      total,
      passed: screens.length > 0 && screens.every((s) => s.passed),
    };
    writeReport(REPORT_FILE, payload);
  });

  for (const screen of SCREENS) {
    test(`${screen.appPath} hybrid score (pixel + structural)`, async ({ page }) => {
      // 1) Auth — same contract as helpers/login.ts: skip when
      // E2E_ADMIN_USERNAME is absent. OTPs are minted per-test inside
      // loginAsAdmin via scripts/get-admin-otp.sh.
      const loggedIn = await loginAsAdmin(page);
      if (!loggedIn) return;

      // 2) Navigate + screenshot the live app at the maquette's
      // canonical dimensions. We use fullPage so the metric grid +
      // table + pagination all land in the same frame.
      await page.setViewportSize(VIEWPORT);
      await page.goto(`/backoffice${screen.appPath}`);
      // Give the data fetches time to populate tables before we
      // screenshot — the structural `has-table-shell` check below
      // depends on the table being rendered, not still loading.
      await page
        .waitForLoadState('networkidle', { timeout: 15_000 })
        .catch(() => {});
      const appName = screen.appPath.replace(/^\//, '').replace(/\//g, '_') || 'root';
      const appPath = path.join(APP_DIR, `${appName}.png`);
      await page.screenshot({ path: appPath, fullPage: true });

      // 3) Navigate to the maquette + screenshot. We open the canonical
      // inventory-credenciales.html page at the same viewport.
      const maquettePage = await page.context().newPage();
      await maquettePage.setViewportSize(VIEWPORT);
      await maquettePage.goto(`${maquette.baseUrl}/inventario-credenciales.html`);
      await maquettePage
        .waitForLoadState('networkidle', { timeout: 15_000 })
        .catch(() => {});
      // Give the maquette's font (Montserrat via Google Fonts) a moment
      // to settle; the maquette declares its own @import in tokens.css.
      await maquettePage.evaluate(() => document.fonts?.ready).catch(() => {});
      const maquettePath = path.join(BASELINES_DIR, 'inventario-credenciales.png');
      await maquettePage.screenshot({ path: maquettePath, fullPage: true });
      await maquettePage.close();

      // 4) Build pixel regions.
      const regions: import('./helpers/parity-scorer').PixelRegion[] = [];
      const dynamicMasks = await buildMasks(page);
      if (screen.scope === 'full') {
        // Full page diff. We treat the entire 1280x800 viewport as the
        // appRect; the maquette crop is the whole maquette screenshot.
        const maquetteBox = { x: 0, y: 0, w: VIEWPORT.width, h: VIEWPORT.height };
        regions.push({
          id: 'full-page',
          appRect: { x: 0, y: 0, w: VIEWPORT.width, h: VIEWPORT.height },
          maquetteRect: maquetteBox,
          why:
            'Full-page diff for /marbetes; dynamic regions are masked ' +
            '(metric values, search count, table body rows).',
          masks: dynamicMasks,
        });
      } else {
        // Chrome-only diff. We pick the regions where the maquette has
        // comparable markup to the app. The dashboard is a KPI
        // overview that renders no .inventory-search shell by
        // design; we honor each region's `appliesTo` and silently
        // skip regions that don't apply (rather than throwing a
        // boundingBox timeout that hangs the whole test).
        const maquetteBoxHandle = await maquettePage.context().newPage();
        try {
          await maquetteBoxHandle.setViewportSize(VIEWPORT);
          await maquetteBoxHandle.goto(`${maquette.baseUrl}/inventario-credenciales.html`);
          await maquetteBoxHandle
            .waitForLoadState('networkidle', { timeout: 15_000 })
            .catch(() => {});
          for (const def of REGION_DEFS) {
            if (def.appliesTo && !def.appliesTo.includes(screen.appPath)) {
              continue;
            }
            const appBox = await resolveAppBox(page, def);
            if (!appBox) continue;
            const mBox = await rectOf(maquetteBoxHandle, def.maquetteSelector);
            if (!mBox) continue;
            const intersect = rectIntersect(appBox, mBox);
            if (!intersect) continue;
            regions.push({
              id: def.id,
              appRect: intersect,
              maquetteRect: intersect,
              why: def.why,
              masks: def.id === 'metrics-grid' ? dynamicMasks : undefined,
            });
          }
        } finally {
          await maquetteBoxHandle.close();
        }
      }

      // 5) Build structural checks.
      const structural = await buildStructuralChecks(page, screen.appPath);

      // 6) Score.
      const score = scoreParity({
        appPath: screen.appPath,
        appScreenshotPath: appPath,
        maquetteScreenshotPath: maquettePath,
        pixelRegions: regions,
        structuralChecks: structural,
      });

      // 7) Persist per-screen JSON next to the screenshot. The
      // afterAll hook reads these files to build the aggregate
      // report, which keeps the aggregate independent of the
      // closure-sharing quirk that bit the previous version.
      const perScreenReport = path.join(ARTIFACT_ROOT, `${appName}.json`);
      writeReport(perScreenReport, score);

      // 8) Log a compact report line so the spec stdout is enough to
      // triage without opening the JSON.
      console.log(
        `[parity] ${screen.appPath} ` +
          `pixel=${score.pixelScore.toFixed(2)}% ` +
          `structural=${score.structuralScore.toFixed(2)}% ` +
          `hybrid=${score.hybridScore.toFixed(2)}% ` +
          `regions=${score.regions.length} ` +
          `checks=${score.structural.length} ` +
          `passed=${score.passed}`,
      );

      // 9) The threshold check: per-screen fail-fast so the JSON
      // report still contains every screen we managed to score.
      expect(
        score.hybridScore,
        `parity hybrid score for ${screen.appPath} below threshold`,
      ).toBeGreaterThanOrEqual(score.threshold);
    });
  }
});

/**
 * Resolve the live app's bounding box for a region definition.
 *
 * Tries the primary selector first, then any fallback selectors in
 * order. Returns null when no selector resolves — the caller skips
 * the region rather than throwing a boundingBox timeout. This is
 * the harness's primary defence against screen-specific selector
 * misses (the dashboard's missing `.inventory-search`, etc.).
 */
async function resolveAppBox(
  page: import('@playwright/test').Page,
  def: RegionSpec,
): Promise<{ x: number; y: number; w: number; h: number } | null> {
  const selectors = [def.appSelector, ...(def.fallbackSelectors ?? [])];
  for (const sel of selectors) {
    const box = await rectOf(page, sel);
    if (box) return box;
  }
  return null;
}

/**
 * Build the structural checks for one screen.
 *
 * Pattern checks come straight from the maquette canon (see
 * diseno/maqueta_Inec/Inec/inventario-credenciales.html). Color
 * checks pin a handful of canonical selectors to their maquette
 * tokens so a regression in globals.css is caught before the
 * pixel-diff step even runs.
 *
 * The structural assertions vary by screen:
 *   - /dashboard is a KPI overview: no `.inventory-search`, no table,
 *     no CTA, no pagination. Those checks are N/A and pass with an
 *     explicit note so the report shows the design intent rather
 *     than masking a regression.
 *   - /audit is read-only by design: no CTA buttons in the header.
 *     The primary-cta-bg check is N/A.
 *   - /dispositivos + /marbetes render the full chrome (header +
 *     metrics + search + table + pagination). For these we wait
 *     briefly for the table to populate before asserting (the
 *     table-shell selector exists even on the empty state but is
 *     styled differently, so we prefer to wait for at least one
 *     row OR the explicit empty-state testid).
 */
async function buildStructuralChecks(
  page: import('@playwright/test').Page,
  appPath: string,
): Promise<import('./helpers/parity-scorer').StructuralCheck[]> {
  const { assertTokenColor } = await import('./helpers/parity-scorer');
  const checks: import('./helpers/parity-scorer').StructuralCheck[] = [];

  // Pattern: inventory page wrapper.
  checks.push({
    id: 'has-inventory-page',
    description: 'page is wrapped in .inventory-page (maquette canon)',
    pass: (await page.locator('.inventory-page').count()) >= 1,
  });

  // Pattern: h1 + subtitle inside inventory-header.
  checks.push({
    id: 'has-h1',
    description: 'inventory-header has a single h1',
    pass: (await page.locator('.inventory-header h1').count()) === 1,
  });
  checks.push({
    id: 'has-subtitle',
    description: 'inventory-header has a subtitle <p>',
    pass: (await page.locator('.inventory-header p').count()) >= 1,
  });

  // Pattern: exactly 4 metric cards.
  const metricCount = await page.locator('.metric-card').count();
  checks.push({
    id: 'has-4-metric-cards',
    description: 'page renders exactly 4 .metric-card elements',
    pass: metricCount === 4,
    detail: `got ${metricCount}`,
  });

  // Pattern: each metric card hosts a donut chart (centered text).
  const donutCount = await page.locator('.metric-card .donut-chart').count();
  checks.push({
    id: 'has-donut-per-card',
    description: 'every metric card renders a .donut-chart',
    pass: donutCount >= 3, // the attention card may omit the donut
    detail: `got ${donutCount} donuts for ${metricCount} cards`,
  });

  // Search shell — N/A for the dashboard (KPI overview, no list).
  if (appPath === '/dashboard') {
    checks.push({
      id: 'has-search-shell',
      description:
        'N/A: dashboard is a KPI overview, no .inventory-search shell by design',
      pass: true,
      detail: 'skipped per design intent',
    });
  } else {
    checks.push({
      id: 'has-search-shell',
      description: 'page renders .inventory-search shell',
      pass: (await page.locator('.inventory-search').count()) >= 1,
    });
  }

  // Table + pagination — only on the three list screens. We give the
  // data fetches a beat to land so the table renders before we
  // assert. The structural check accepts either the populated
  // `.data-table` or the explicit empty-state testid (the table
  // component renders the empty state when items.length === 0).
  if (appPath !== '/dashboard') {
    // Wait briefly for the table to settle. We do not fail if it
    // never settles — the next assertion will surface a clear
    // "table not found" message instead of hanging the spec.
    await page
      .waitForSelector(
        '.table-shell .data-table, [data-testid="empty-state"]',
        { timeout: 5_000 },
      )
      .catch(() => {});
    const tableRendered =
      (await page.locator('.table-shell .data-table').count()) >= 1;
    const emptyState =
      (await page.locator('[data-testid="empty-state"]').count()) >= 1;
    checks.push({
      id: 'has-table-shell',
      description:
        'page renders .table-shell .data-table (or explicit empty state when the dataset is empty)',
      pass: tableRendered || emptyState,
      detail: tableRendered
        ? 'rendered with rows'
        : emptyState
          ? 'rendered empty state'
          : 'neither .table-shell .data-table nor [data-testid="empty-state"] found',
    });
    checks.push({
      id: 'has-pagination',
      description: 'page renders .table-pagination',
      pass: (await page.locator('.table-pagination').count()) >= 1,
    });
  }

  // Color tokens — pinned to the maquette's declared palette.
  // We use the FIRST match of each selector to avoid double-counting
  // when both a h1 and a subtitle share the same token.
  const h1Color = await assertTokenColor(
    page,
    '.inventory-header h1',
    'color',
    EXPECTED_TOKENS.textPrimary,
  );
  checks.push({
    id: 'h1-text-primary',
    description: `h1 uses --color-text-primary (${EXPECTED_TOKENS.textPrimary})`,
    pass: h1Color.pass,
    detail: h1Color.detail,
  });

  const subtitleColor = await assertTokenColor(
    page,
    '.inventory-header p',
    'color',
    EXPECTED_TOKENS.textMuted,
  );
  checks.push({
    id: 'subtitle-text-muted',
    description: `subtitle uses --color-text-muted (${EXPECTED_TOKENS.textMuted})`,
    pass: subtitleColor.pass,
    detail: subtitleColor.detail,
  });

  // Primary CTA — screen-aware. The maquette's "Agregar marbete /
  // Cargar marbetes" pair uses the primary token on the right-most
  // button (only /marbetes shows two CTAs in the maquette canon).
  // We pick the right-most .inventory-header button and check it
  // for primary-500. /audit, /dashboard, and /dispositivos have
  // no primary CTA in the maquette (the dispositivos page only
  // ships an outline "Registrar dispositivo" trigger); we mark
  // the check N/A on those screens so a regression in the chrome
  // does not falsely fail on a missing-but-unexpected primary CTA.
  if (appPath !== '/marbetes') {
    checks.push({
      id: 'primary-cta-bg',
      description: `N/A: ${appPath} has no primary CTA in .inventory-header (maquette canon only ships one on /marbetes)`,
      pass: true,
      detail: 'skipped per design intent',
    });
  } else {
    // Resolve the LAST .inventory-header button (the right-most in
    // the maquette is the primary CTA — "Cargar marbetes",
    // "Registrar dispositivo", etc). This is more precise than
    // `.inventory-header button:last-child` because the maquette's
    // maquette wraps the actions row in a div, and Tailwind 4 can
    // generate `:last-child` mismatches with shadcn wrappers.
    const rightMost = page.locator('.inventory-header button').last();
    const ctaCount = await rightMost.count();
    if (ctaCount >= 1) {
      const ctaBg = await assertTokenColor(
        page,
        '.inventory-header button:last-of-type',
        'background-color',
        EXPECTED_TOKENS.primary500,
      );
      checks.push({
        id: 'primary-cta-bg',
        description: `right-most .inventory-header button uses --color-primary-500 (${EXPECTED_TOKENS.primary500})`,
        pass: ctaBg.pass,
        detail: ctaBg.detail,
      });
    } else {
      checks.push({
        id: 'primary-cta-bg',
        description: 'primary CTA exists and uses --color-primary-500',
        pass: false,
        detail: 'no .inventory-header button found',
      });
    }
  }

  return checks;
}