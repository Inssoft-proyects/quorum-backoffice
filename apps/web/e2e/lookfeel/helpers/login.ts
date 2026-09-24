import type { Page } from '@playwright/test';

/**
 * Seeded users from the production backoffice (read-only audit).
 * Hard-coded because the audit must run against prod without depending on
 * CI-only environment variables that might differ across runners.
 *
 * Polish WU v6: the `password` field is preserved for backwards
 * compatibility with existing call sites that still use the legacy
 * flow (e.g. local dev without OTP) but the canonical login flow is
 * now email + OTP. New tests should prefer `loginWithOtp` or, for
 * read-only audit runs against staging, the inline form helpers in
 * `10-auth-otp.spec.ts`.
 */
export const SEED_USERS = {
  admin: { email: 'admin@quorum.local', password: 'admin1234' },
  auditor: { email: 'auditor@quorum.local', password: 'auditor1234' },
  operator: { email: 'operator@quorum.local', password: 'operator1234' },
} as const;

export type Role = keyof typeof SEED_USERS;

/** Authed screens reachable from the app shell sidebar. */
export const AUTHED_SCREENS: ReadonlyArray<string> = [
  '/dashboard',
  '/marbetes',
  '/dispositivos',
  '/audit',
];

/**
 * Logs the page in as the given role using the legacy email+password
 * form (kept for backwards compatibility with local dev environments
 * that still expose the password path; the production /login route
 * accepts the field but ignores it).
 *
 * New tests SHOULD prefer `loginWithOtp` (or the inline helpers in
 * 10-auth-otp.spec.ts) so the test reflects the actual production
 * contract.
 */
export async function loginAs(page: Page, role: Role): Promise<void> {
  const user = SEED_USERS[role];
  await page.goto('/backoffice/login');
  await page.getByLabel('Correo').fill(user.email);
  // Legacy password input is no longer rendered; fill any input by
  // name=password if it ever reappears, otherwise skip.
  const passwordInput = page.locator('input[name="password"]');
  if ((await passwordInput.count()) > 0) {
    await passwordInput.fill(user.password);
    await page.getByRole('button', { name: /Ingresar/i }).click();
  } else {
    // Production: drive the email step; the rest of the flow is
    // covered by 10-auth-otp.spec.ts.
    await page.getByTestId('login-request-otp').click();
  }
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
}

/**
 * Polish WU v6: drive the 2-step OTP flow with a caller-supplied code.
 *
 * The OTP must be intercepted from the SMTP delivery channel
 * (production) or read from the mailer's dev-mode warn log (local
 * dev). Use only in suites that own the OTP delivery path.
 */
export async function loginWithOtp(page: Page, email: string, otp: string): Promise<void> {
  await page.goto('/backoffice/login');
  await page.getByLabel('Correo').fill(email);
  await page.getByTestId('login-request-otp').click();
  await page.getByTestId('login-otp').waitFor({ state: 'visible', timeout: 10_000 });
  // Paste the code into the first digit box; OtpInput fills the rest.
  await page.getByLabel('Digit 1 of 6').click();
  await page.keyboard.insertText(otp);
  await page.getByTestId('login-submit-otp').click();
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
}

/**
 * Clears the auth cookie so the next login is a fresh session. Use between
 * role tests when reusing a browser context for speed.
 */
export async function clearSession(page: Page): Promise<void> {
  await page.context().clearCookies();
}
