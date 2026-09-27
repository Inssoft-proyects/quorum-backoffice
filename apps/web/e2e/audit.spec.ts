import { test, expect } from '@playwright/test';
import { loginAs } from './lookfeel/helpers/login';

/**
 * Read-only audit specs for /audit (auditor + operator roles).
 *
 * Migrated to the deployed `/backoffice/login` username + pre-issued
 * OTP flow. Authentication goes through the guarded helper, which
 * reads `E2E_<ROLE>_USERNAME` and `E2E_<ROLE>_OTP` from the environment
 * and skips safely when either is missing — the helper never derives a
 * username from an email and never provides a default OTP.
 */

test('auditor can view /backoffice/audit page with filters and rows', async ({ page }) => {
  await loginAs(page, 'auditor');
  await page.goto('/backoffice/audit');
  await expect(page.getByText('Auditoría')).toBeVisible();
  await expect(page.getByTestId('audit-filters')).toBeVisible();
});

test('operator is redirected away from /backoffice/audit', async ({ page }) => {
  await loginAs(page, 'operator');
  await page.goto('/backoffice/audit');
  await expect(page).toHaveURL(/\/dashboard/);
});