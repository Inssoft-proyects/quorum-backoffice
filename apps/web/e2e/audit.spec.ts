import { test, expect } from '@playwright/test';

test('auditor can view /audit page with filters and rows', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Correo').fill(process.env.E2E_AUDITOR_EMAIL ?? 'auditor@quorum.local');
  await page.getByLabel('Contraseña').fill(process.env.E2E_AUDITOR_PASSWORD ?? 'auditor1234');
  await page.getByRole('button', { name: /Ingresar/i }).click();
  await page.goto('/audit');
  await expect(page.getByText('Auditoría')).toBeVisible();
  await expect(page.getByTestId('audit-filters')).toBeVisible();
});

test('operator is redirected away from /audit', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Correo').fill(process.env.E2E_OPERATOR_EMAIL ?? 'operator@quorum.local');
  await page.getByLabel('Contraseña').fill(process.env.E2E_OPERATOR_PASSWORD ?? 'operator1234');
  await page.getByRole('button', { name: /Ingresar/i }).click();
  await page.goto('/audit');
  await expect(page).toHaveURL(/\/dashboard/);
});
