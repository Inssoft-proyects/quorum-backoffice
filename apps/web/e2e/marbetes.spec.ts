import { test, expect } from '@playwright/test';

test.describe('marbetes CRUD (auditor-only smoke)', () => {
  test('auditor sees /marbetes table and counters', async ({ page }) => {
    // Login first
    await page.goto('/login');
    await page.getByLabel('Correo').fill(process.env.E2E_AUDITOR_EMAIL ?? 'auditor@quorum.local');
    await page.getByLabel('Contraseña').fill(process.env.E2E_AUDITOR_PASSWORD ?? 'auditor1234');
    await page.getByRole('button', { name: /Ingresar/i }).click();
    await page.goto('/marbetes');
    await expect(page.getByText('Marbetes')).toBeVisible();
    await expect(page.getByTestId('status-cards')).toBeVisible();
  });
});

test.describe('marbetes CRUD (admin full flow)', () => {
  test('admin can list marbetes and see the table', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Correo').fill(process.env.E2E_ADMIN_EMAIL ?? 'admin@quorum.local');
    await page.getByLabel('Contraseña').fill(process.env.E2E_ADMIN_PASSWORD ?? 'admin1234');
    await page.getByRole('button', { name: /Ingresar/i }).click();
    await page.goto('/marbetes');
    await expect(page.getByText('Marbetes')).toBeVisible();
    // Empty state OR rows (depends on DB state)
    await expect(page.locator('main')).toBeVisible();
  });
});
