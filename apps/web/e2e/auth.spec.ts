import { test, expect, type Route } from '@playwright/test';
import { loginAs } from './lookfeel/helpers/login';

/**
 * Authentication integration specs for the BackOffice.
 *
 * Migrated from the legacy email + password / request-code flow to the
 * deployed `username + pre-issued OTP` single-step form served at
 * `/backoffice/login` (Next.js basePath '/backoffice' under the
 * BackOffice host).
 *
 * Conventions:
 *   - Authenticated paths go through the guarded helper, which reads
 *     `E2E_<ROLE>_USERNAME` and `E2E_<ROLE>_OTP` and skips safely when
 *     either is missing. No defaults, no derivation from email.
 *   - UI-only negative paths (invalid OTP) MUST NOT hit the live API;
 *     they install a synthetic Playwright route handler that fulfils a
 *     401 response and never lets the request leave the browser.
 */

async function interceptInvalidLogin(
  page: import('@playwright/test').Page,
): Promise<{ bodies: Array<Record<string, unknown>> }> {
  const bodies: Array<Record<string, unknown>> = [];
  await page.route('**/api/v1/auth/login', async (route: Route) => {
    try {
      bodies.push(JSON.parse(route.request().postData() ?? '{}'));
    } catch {
      bodies.push({});
    }
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'invalid_otp' }),
    });
  });
  return { bodies };
}

test('unauthenticated user is redirected to /backoffice/login from /backoffice/dashboard', async ({ page }) => {
  await page.goto('/backoffice/dashboard');
  await expect(page).toHaveURL(/\/backoffice\/login/);
});

test('valid login lands on /backoffice/dashboard (guarded by E2E_ADMIN_USERNAME + E2E_ADMIN_OTP)', async ({
  page,
}) => {
  await loginAs(page, 'admin');
  await expect(page).toHaveURL(/\/dashboard/);
});

test('invalid OTP shows an inline error and stays on /backoffice/login (UI-only, intercepted)', async ({
  page,
}) => {
  const { bodies } = await interceptInvalidLogin(page);
  await page.goto('/backoffice/login');
  await page.getByTestId('login-username').fill('admin');
  await page.getByTestId('login-otp').fill('WRONG1');
  await page.getByTestId('login-submit').click();

  // The synthetic handler received exactly { username, otp } — never a
  // password or request-code body — and answered 401, so the form
  // surfaces the inline alert and we stay on /backoffice/login.
  await expect(page.getByTestId('login-error')).toBeVisible({ timeout: 10_000 });
  expect(new URL(page.url()).pathname).toBe('/backoffice/login');
  expect(page.url()).not.toContain('/dashboard');
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toEqual({ username: 'admin', otp: 'WRONG1' });
});