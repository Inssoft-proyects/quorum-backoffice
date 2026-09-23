import { test, expect, type Page } from '@playwright/test';
import { clearSession, loginAs, SEED_USERS, type Role } from './helpers/login';
import { captureSnapshot } from './helpers/snapshot';

/**
 * T2 — Auth matrix + smoke screens for the three seeded roles.
 *
 * Each test starts with a fresh browser context so cookies never leak
 * across role boundaries. Screenshots captured here double as the
 * visual baseline for T3 / T4.
 */

test.describe('T2 — auth & roles', () => {
  test('unauthenticated visit to /dashboard redirects to /login', async ({ page }) => {
    await page.goto('/backoffice/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });

  test('admin login lands on /dashboard with email in topbar', async ({ page }) => {
    await loginAs(page, 'admin');
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.locator('header')).toContainText(SEED_USERS.admin.email);
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

  test('invalid credentials show alert and keep URL on /login', async ({ page }) => {
    await page.goto('/backoffice/login');
    await page.getByLabel('Correo').fill('nope@quorum.local');
    await page.getByLabel('Contraseña').fill('wrong-password-xyz');
    await page.getByRole('button', { name: /Ingresar/i }).click();
    // Match the visible error alert (not Next.js' route announcer).
    await expect(page.getByText(/Email o contraseña incorrectos/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('operator is redirected away from /audit (RBAC)', async ({ page }) => {
    await loginAs(page, 'operator');
    await page.goto('/backoffice/audit');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  // Smoke: the three authed screens render for an admin without errors.
  // Dialogs are covered in T6; here we only confirm the page chrome.
  const SMOKE_ROLES: Role[] = ['admin', 'auditor', 'operator'];
  for (const role of SMOKE_ROLES) {
    test(`smoke: ${role} can reach /dashboard`, async ({ page }) => {
      await loginAs(page, role);
      await expect(page.locator('main')).toBeVisible();
      // Header must show the user email
      await expect(page.locator('header')).toContainText(SEED_USERS[role].email);
      await clearSession(page);
    });
  }
});

// Utility used by other suites: ensure no cookies leak between tests
// when reusing a context.
export async function resetContext(page: Page): Promise<void> {
  await clearSession(page);
}
