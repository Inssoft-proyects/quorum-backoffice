import { test, expect, type Page, type Route } from '@playwright/test';
import { clearSession, loginAs, type Role } from './helpers/login';
import { captureSnapshot } from './helpers/snapshot';

/**
 * T2 — Auth matrix + smoke screens for the three seeded roles.
 *
 * Each test starts with a fresh browser context so cookies never leak
 * across role boundaries. Screenshots captured here double as the
 * visual baseline for T3 / T4.
 *
 * Authed screens are routed through the env-gated `loginAs` helper,
 * which safely `test.skip()`s when the runner is missing explicit
 * `E2E_<ROLE>_USERNAME` + `E2E_<ROLE>_OTP` values; the helper never
 * invents or derives credentials, and never assumes an email. The
 * only email-specific data we previously asserted was the topbar
 * identifier and a `[role=alert]` text, both of which were tied to
 * the legacy email + password flow that is gone.
 */

/**
 * Intercept POST `/api/v1/auth/login` and fulfill a synthetic JSON
 * response, so UI-level invalid-login specs never hit the live API.
 * Returns the recorded request bodies so callers can assert the
 * exact `{ username, otp }` wire shape if needed.
 */
async function interceptAuthLogin(
  page: Page,
  status: number,
  body: Record<string, unknown>,
): Promise<{ bodies: Array<Record<string, unknown>> }> {
  const bodies: Array<Record<string, unknown>> = [];
  await page.route('**/api/v1/auth/login', async (route: Route) => {
    const req = route.request();
    try {
      bodies.push(JSON.parse(req.postData() ?? '{}'));
    } catch {
      bodies.push({});
    }
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  return { bodies };
}

test.describe('T2 — auth & roles', () => {
  test('unauthenticated visit to /dashboard redirects to /login', async ({ page }) => {
    await page.goto('/backoffice/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });

  test('admin login lands on /dashboard with role badge in topbar', async ({ page }) => {
    await loginAs(page, 'admin');
    await expect(page).toHaveURL(/\/dashboard/);
    // Topbar exposes the user role as an explicit Badge; we assert
    // that identifier instead of an email, because the migrated login
    // is by username + OTP and no email is configured for the E2E
    // roles. The badge text is whatever `user.role` reports.
    await expect(page.locator('header')).toContainText('admin');
    await captureSnapshot(page, { name: '/dashboard', role: 'admin' });
  });

  test('auditor login lands on /dashboard and sees Auditoría in sidebar', async ({ page }) => {
    await loginAs(page, 'auditor');
    await expect(page).toHaveURL(/\/dashboard/);
    const sidebar = page.locator('aside');
    await expect(sidebar.getByRole('link', { name: 'Auditoría' })).toBeVisible();
    await captureSnapshot(page, { name: '/dashboard', role: 'auditor' });
  });

  test('operator login lands on /dashboard and Auditoría is NOT in sidebar', async ({ page }) => {
    await loginAs(page, 'operator');
    await expect(page).toHaveURL(/\/dashboard/);
    const sidebar = page.locator('aside');
    await expect(sidebar.getByRole('link', { name: 'Auditoría' })).toHaveCount(0);
    await captureSnapshot(page, { name: '/dashboard', role: 'operator' });
  });

  test('invalid credentials surface login-error and keep URL on /login', async ({ page }) => {
    // UI-only: the synthetic 401 keeps the request off the wire so
    // the test never exercises a real lockout against the live API.
    await interceptAuthLogin(page, 401, { error: 'invalid_credentials' });

    await page.goto('/backoffice/login');
    await page.getByTestId('login-username').fill('nonexistent-user');
    await page.getByTestId('login-otp').fill('WRONG1');
    await page.getByTestId('login-submit').click();

    await expect(page.getByTestId('login-error')).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(/\/login/);
  });

  test('operator is redirected away from /audit (RBAC)', async ({ page }) => {
    await loginAs(page, 'operator');
    await page.goto('/backoffice/audit');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  // Smoke: the three authed screens render for an admin without errors.
  // Dialogs are covered in T6; here we only confirm the page chrome
  // and the role badge (no email is assumed because the migrated login
  // flow is username + OTP only — no email is configured for E2E).
  const SMOKE_ROLES: Role[] = ['admin', 'auditor', 'operator'];
  for (const role of SMOKE_ROLES) {
    test(`smoke: ${role} can reach /dashboard`, async ({ page }) => {
      await loginAs(page, role);
      await expect(page.locator('main')).toBeVisible();
      await expect(page.locator('header')).toContainText(role);
      await clearSession(page);
    });
  }
});

// Utility used by other suites: ensure no cookies leak between tests
// when reusing a context.
export async function resetContext(page: Page): Promise<void> {
  await clearSession(page);
}
