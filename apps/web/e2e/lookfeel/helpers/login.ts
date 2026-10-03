import { test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * Roles that the BackOffice seeded for the read-only UI/UX audit.
 *
 * Each role's credentials are NOT derived from a known seed; the helper
 * reads the username from an explicit environment variable and
 * either mints a fresh OTP via the operator console contract (admin)
 * or reads a pre-issued OTP from the environment (other roles).
 *
 * Required environment variables per role:
 *   E2E_<ROLE>_USERNAME  — the BackOffice username (NOT an email).
 *                          Required for every role.
 *   E2E_<ROLE>_OTP       — the pre-issued OTP code (uppercase A–Z0–9).
 *                          Required for `operator` and `auditor` roles.
 *                          Ignored for `admin`: BackOffice OTPs are
 *                          single-use, so the admin helper always
 *                          mints a fresh code via
 *                          `scripts/get-admin-otp.sh` (HMAC against
 *                          the k8s-stored OTP_SERVICE_TOKEN) so the
 *                          suite cannot burn the first code across
 *                          multiple tests.
 *
 * When the required variable is missing (or minting fails), the
 * calling test is skipped safely via `test.skip()`; the helper never
 * falls back to a hard-coded username or OTP and never derives a
 * username from an email address.
 */
export type Role = 'admin' | 'auditor' | 'operator';

export const ROLES: ReadonlyArray<Role> = ['admin', 'auditor', 'operator'];

/** Authed screens reachable from the app shell sidebar. */
export const AUTHED_SCREENS: ReadonlyArray<string> = [
  '/dashboard',
  '/marbetes',
  '/dispositivos',
  '/audit',
];

/**
 * Resolve the OTP the suite must use for the given role.
 *
 *   - `admin`: always mint a fresh OTP via the helper script (mirrors
 *     the same contract `12-maquette-parity.spec.ts` uses for its
 *     `issueFreshOtp()`). Reusing `E2E_ADMIN_OTP` across the eleven
 *     tests of `13-asociar-screen.spec.ts` and
 *     `14-bulk-upload-flow.spec.ts` would burn the first code and
 *     surface `invalid_credentials` on tests 2..11.
 *   - `auditor` / `operator`: read the explicit env var for
 *     back-compat with other specs (`11-maquette-v3.spec.ts`,
 *     `05-interaction-flows.spec.ts`, `09-audit-design.spec.ts`,
 *     `07-mobile-nav.spec.ts`, `08-dispositivos-design.spec.ts`)
 *     that already pass `E2E_<ROLE>_OTP` and expect a static
 *     env-driven login.
 *
 * The tagged `ok` flag keeps TypeScript narrowing explicit at the
 * call site. When minting or env lookup fails, callers MUST treat
 * that as a signal to skip the test rather than to fabricate
 * credentials.
 */
type RoleOtp =
  | { ok: true; otp: string }
  | { ok: false; reason: string };

function issueFreshOtp(): string {
  // scripts/get-admin-otp.sh reproduces the HMAC contract that
  // quorum-otp expects (HMAC-SHA256 over "<ts>.<body>" against the
  // k8s-stored OTP_SERVICE_TOKEN). The script is reused — not
  // reimplemented — so the operator-sound fleet and the test runner
  // cannot drift. The shared secret is never written to disk or
  // stdout; only the OTP token (single-use by design) is returned.
  // helpers/login.ts lives at apps/web/e2e/lookfeel/helpers/login.ts
  // (one level deeper than 12-maquette-parity.spec.ts and
  // 14-bulk-upload-flow.spec.ts, which sit at apps/web/e2e/lookfeel/).
  // Five `..` is therefore needed to reach the repo root where
  // scripts/get-admin-otp.sh lives.
  const script = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    'scripts',
    'get-admin-otp.sh',
  );
  return execFileSync(script, [], { encoding: 'utf-8' }).trim();
}

function resolveRoleOtp(role: Role): RoleOtp {
  const tag = role.toUpperCase();
  const username = process.env[`E2E_${tag}_USERNAME`]?.trim();
  if (!username) {
    return {
      ok: false,
      reason: `E2E_${tag}_USERNAME is not set; skipping the test safely.`,
    };
  }

  if (role === 'admin') {
    // Single-use codes cannot be reused; mint a fresh one for every
    // call. The helper script honours `E2E_OTP_SUBJECT` /
    // `E2E_OTP_SCOPE` and defaults to subject=admin / scope=login,
    // matching the BackOffice username form.
    try {
      return { ok: true, otp: issueFreshOtp() };
    } catch (err) {
      return {
        ok: false,
        reason:
          `could not mint admin OTP via scripts/get-admin-otp.sh: ` +
          `${(err as Error).message}`,
      };
    }
  }

  // Back-compat path for operator / auditor roles: the env var
  // already carries the OTP and the helper never invents one.
  const otp = process.env[`E2E_${tag}_OTP`]?.trim();
  if (!otp) {
    return { ok: false, reason: `E2E_${tag}_OTP is not set; skipping the test safely.` };
  }
  return { ok: true, otp };
}

/**
 * Logs the page in as the given role using the username + pre-issued
 * OTP form on `/backoffice/login`.
 *
 * The form drives the real single-step login flow:
 *   1. Navigate to `/backoffice/login`.
 *   2. Type the username into `login-username`.
 *   3. Type the OTP into the 6-box `login-otp` OtpInput. The group
 *      is a `role="group"` `<div>` whose child `<input>` boxes are
 *      labelled "Digit N of 6"; calling `getByTestId('login-otp')
 *      .fill(...)` against the wrapper is rejected by Playwright
 *      because the wrapper is not editable. We focus the first box
 *      and drive the shared keyboard so the OtpInput's auto-advance
 *      handler (`components/ui/otp-input.tsx`) fills the remaining
 *      five boxes — exactly the pattern used by
 *      `10-auth-otp.spec.ts → fillOtpBoxes`. Uppercase A–Z0–9 is
 *      forced by the OtpInput itself.
 *   4. Click `login-submit` and wait for the redirect to `/dashboard`.
 *
 * When the required env vars are missing or the OTP mint fails,
 * the test is skipped via `test.skip()` so an unconfigured runner
 * surfaces as "skipped" rather than "failed" or "fabricated login".
 */
export async function loginAs(page: Page, role: Role): Promise<void> {
  const env = resolveRoleOtp(role);
  if (!env.ok) {
    test.skip(true, env.reason);
    return;
  }
  const tag = role.toUpperCase();
  const username = process.env[`E2E_${tag}_USERNAME`]?.trim() ?? '';

  await page.goto('/backoffice/login');
  await page.getByTestId('login-username').fill(username);
  // 6-box OtpInput: focus the first box and let the component's
  // auto-advance fill the rest. We avoid `.fill()` on the group
  // wrapper because the wrapper is a non-editable `<div role="group">`
  // and Playwright rejects `.fill()` on non-editable elements.
  await page.getByRole('textbox', { name: 'Digit 1 of 6' }).click();
  await page.keyboard.type(env.otp);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
}

/**
 * Clears the auth cookie so the next login is a fresh session. Use between
 * role tests when reusing a browser context for speed.
 */
export async function clearSession(page: Page): Promise<void> {
  await page.context().clearCookies();
}