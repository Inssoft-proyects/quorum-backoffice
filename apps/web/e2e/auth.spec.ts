import { test, expect } from '@playwright/test';

test('unauthenticated user is redirected to /login from /dashboard', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login/);
});

test('valid login lands on /dashboard with user info', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Correo').fill(process.env.E2E_ADMIN_EMAIL ?? 'admin@quorum.local');
  await page.getByLabel('Contraseña').fill(process.env.E2E_ADMIN_PASSWORD ?? 'admin1234');
  await page.getByRole('button', { name: /Ingresar/i }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  // Email appears in the topbar
  await expect(page.locator('header')).toContainText(
    process.env.E2E_ADMIN_EMAIL ?? 'admin@quorum.local',
  );
});

test('invalid login shows error alert and stays on /login', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Correo').fill('nope@quorum.local');
  await page.getByLabel('Contraseña').fill('wrong-password-xyz');
  await page.getByRole('button', { name: /Ingresar/i }).click();
  await expect(page.getByRole('alert')).toContainText(/incorrectos|inválid/i);
  await expect(page).toHaveURL(/\/login/);
});
