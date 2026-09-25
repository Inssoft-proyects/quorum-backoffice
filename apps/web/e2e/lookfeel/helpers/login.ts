import { test, type Page } from '@playwright/test';

/**
 * Roles that the BackOffice seeded for the read-only UI/UX audit.
 *
 * Each role's credentials are NOT derived from a known seed; the helper
 * reads them from explicit environment variables so the suite stays
 * decoupled from any concrete user record (the BackOffice now logs in
 * by `username + pre-issued OTP`, and the OTP is delivered out of band
 * by the Quorum OTP service).
 *
 * Required environment variables per role:
 *   E2E_<ROLE>_USERNAME  — the BackOffice username (NOT an email)
 *   E2E_<ROLE>_OTP       — the pre-issued OTP code (uppercase alphanumeric)
 *
 * When either variable is missing for the requested role, the calling
 * test is skipped safely via `test.skip()`; the helper never falls back
 * to a hard-coded username or OTP and never derives a username from an
 * email address.
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
 * Resolves the explicit environment variables for the requested role.
 *
 * Returns `{ ok: false, reason }` when either variable is missing;
 * callers MUST treat that as a signal to skip the test rather than to
 * fabricate credentials. The tagged `ok` flag keeps TypeScript
 * narrowing explicit at the call site.
 */
type RoleEnv =
  | { ok: true; username: string; otp: string }
  | { ok: false; reason: string };

function resolveRoleEnv(role: Role): RoleEnv {
  const tag = role.toUpperCase();
  const username = process.env[`E2E_${tag}_USERNAME`]?.trim();
  const otp = process.env[`E2E_${tag}_OTP`]?.trim();
  if (!username && !otp) {
    return {
      ok: false,
      reason: `E2E_${tag}_USERNAME and E2E_${tag}_OTP are not set; skipping the test safely.`,
    };
  }
  if (!username) {
    return { ok: false, reason: `E2E_${tag}_USERNAME is not set; skipping the test safely.` };
  }
  if (!otp) {
    return { ok: false, reason: `E2E_${tag}_OTP is not set; skipping the test safely.` };
  }
  return { ok: true, username, otp };
}

/**
 * Logs the page in as the given role using the username + pre-issued
 * OTP form on `/backoffice/login`.
 *
 * The OTP is supplied verbatim by the caller (read from the
 * `E2E_<ROLE>_OTP` environment variable); the helper never invents,
 * defaults, or derives one. When the required variables are missing,
 * the test is skipped via `test.skip()` so an unconfigured runner
 * surfaces as "skipped" rather than "failed" or "fabricated login".
 *
 * The form drives the real single-step login flow:
 *   1. Navigate to `/backoffice/login`.
 *   2. Type the username into `login-username`.
 *   3. Type the OTP into `login-otp` (forced uppercase A–Z0–9).
 *   4. Click `login-submit` and wait for the redirect to `/dashboard`.
 */
export async function loginAs(page: Page, role: Role): Promise<void> {
  const env = resolveRoleEnv(role);
  if (!env.ok) {
    test.skip(true, env.reason);
    return;
  }
  await page.goto('/backoffice/login');
  await page.getByTestId('login-username').fill(env.username);
  await page.getByTestId('login-otp').fill(env.otp);
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