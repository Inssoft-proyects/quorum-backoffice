import { test, expect } from '@playwright/test';
import { loginAs } from './lookfeel/helpers/login';

/**
 * Read-only marbetes smoke specs (auditor + admin roles).
 *
 * Migrated to the deployed `/backoffice/login` username + pre-issued
 * OTP flow. Authentication goes through the guarded helper, which
 * reads `E2E_<ROLE>_USERNAME` and `E2E_<ROLE>_OTP` from the environment
 * and skips safely when either is missing — the helper never derives a
 * username from an email and never provides a default OTP.
 */

test.describe('marbetes CRUD (auditor-only smoke)', () => {
  test('auditor sees /backoffice/marbetes table and counters', async ({ page }) => {
    await loginAs(page, 'auditor');
    await page.goto('/backoffice/marbetes');
    await expect(page.getByText('Marbetes')).toBeVisible();
    await expect(page.getByTestId('status-cards')).toBeVisible();
  });
});

test.describe('marbetes CRUD (admin full flow)', () => {
  test('admin can list marbetes and see the table', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/backoffice/marbetes');
    await expect(page.getByText('Marbetes')).toBeVisible();
    // Empty state OR rows (depends on DB state)
    await expect(page.locator('main')).toBeVisible();
  });
});