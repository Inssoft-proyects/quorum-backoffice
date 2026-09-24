import { test, expect } from '@playwright/test';

/**
 * Polish WU v6 / B7 — maquette v3 visual regression.
 *
 * Drives the local stack (web on :5099, API on :5100, mock OTP on :18080)
 * to verify that the rendered screens match the HTML canon in
 * `diseno/maqueta_Inec/Inec/inventario-credenciales.html`.
 *
 * Each test loads a screen, asserts the heading + 4 metric labels, and
 * captures a screenshot into `apps/web/e2e/lookfeel/artifacts/` for
 * manual visual diff against the maquette PNGs.
 *
 * The full happy-path login is required because every authed screen
 * redirects to /login if the session cookie is missing.
 */

const SEED = {
  email: 'admin@quorum.local',
  password: 'admin1234', // legacy field, ignored by the OTP flow
  otp: '123456', // deterministic code issued by apps/api/scripts/mock-otp-service.ts
};

async function loginAsOperator(page: import('@playwright/test').Page) {
  await page.goto('/backoffice/login');
  await page.getByLabel('Correo').fill(SEED.email);
  await page.getByTestId('login-request-otp').click();
  await page.getByTestId('login-otp').waitFor({ state: 'visible', timeout: 10_000 });
  const firstBox = page.getByLabel('Digit 1 of 6');
  await firstBox.click();
  await firstBox.fill(SEED.otp[0] ?? '');
  // Dispatch a paste event with the full OTP. The OtpInput's
  // onPaste handler fills all six boxes in one go.
  await page.evaluate((otp) => {
    const input = document.activeElement;
    if (input) {
      const dt = new DataTransfer();
      dt.setData('text/plain', otp);
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
    }
  }, SEED.otp);
  await page.getByTestId('login-submit-otp').click();
  await page.waitForURL(new RegExp('/backoffice/dashboard'), { timeout: 15_000 });
}

test.describe('Maquette v3 visual regression (Polish WU v6 / B7)', () => {
  test('T11.1 /marbetes renders the 4 metric cards + heading from the maquette', async ({ page }) => {
    await loginAsOperator(page);
    await page.goto('/backoffice/marbetes');
    await expect(page.getByRole('heading', { name: 'Inventario de marbetes' })).toBeVisible();
    // 4 metric cards from the maquette. Use scoped selectors to avoid
    // matching the 'X% del total' string in the attention card.
    const metrics = page.locator('.metric-card');
    await expect(metrics).toHaveCount(4);
    await expect(metrics.filter({ hasText: 'Total' }).first()).toBeVisible();
    await expect(metrics.filter({ hasText: 'Disponibles' }).first()).toBeVisible();
    await expect(metrics.filter({ hasText: 'Asignados' }).first()).toBeVisible();
    await expect(metrics.filter({ hasText: 'Por atender' }).first()).toBeVisible();
    // CTA buttons.
    await expect(page.getByTestId('add-marbete-trigger')).toBeVisible();
    await expect(page.getByTestId('upload-marbetes-trigger')).toBeVisible();
    // Table column headers (subset that the maquette shows).
    await expect(page.getByRole('columnheader', { name: 'No. Marbete' })).toBeVisible();
    await page.screenshot({
      path: 'e2e/lookfeel/artifacts/marbetes-v3.png',
      fullPage: true,
    });
  });

  test('T11.2 /dispositivos renders the same pattern as /marbetes', async ({ page }) => {
    await loginAsOperator(page);
    await page.goto('/backoffice/dispositivos');
    await expect(page.getByRole('heading', { name: 'Inventario de dispositivos' })).toBeVisible();
    const metrics = page.locator('.metric-card');
    await expect(metrics).toHaveCount(4);
    await expect(metrics.filter({ hasText: 'Total' }).first()).toBeVisible();
    // /dispositivos uses its own metric set (Activos / Revocados /
    // Sin marca) — not the marbetes-style (Disponibles / Asignados /
    // Por atender). The maquette doesn't specify /dispositivos, so the
    // current copy is authoritative.
    await expect(metrics.filter({ hasText: 'Activos' }).first()).toBeVisible();
    await expect(metrics.filter({ hasText: 'Revocados' }).first()).toBeVisible();
    await expect(metrics.filter({ hasText: 'Sin marca' }).first()).toBeVisible();
    await page.screenshot({
      path: 'e2e/lookfeel/artifacts/dispositivos-v3.png',
      fullPage: true,
    });
  });

  test('T11.3 /audit renders the 4 cards with the maquet-derived labels', async ({ page }) => {
    await loginAsOperator(page);
    await page.goto('/backoffice/audit');
    const metrics = page.locator('.metric-card');
    await expect(metrics).toHaveCount(4);
    await expect(metrics.filter({ hasText: 'Total' }).first()).toBeVisible();
    await expect(metrics.filter({ hasText: 'Marbetes' }).first()).toBeVisible();
    await expect(metrics.filter({ hasText: 'Dispositivos' }).first()).toBeVisible();
    await expect(metrics.filter({ hasText: 'Autenticación' }).first()).toBeVisible();
    await page.screenshot({
      path: 'e2e/lookfeel/artifacts/audit-v3.png',
      fullPage: true,
    });
  });

  test('T11.4 /dashboard renders without errors', async ({ page }) => {
    await loginAsOperator(page);
    await page.waitForURL(new RegExp('/backoffice/dashboard'), { timeout: 15_000 });
    await page.screenshot({
      path: 'e2e/lookfeel/artifacts/dashboard-v3.png',
      fullPage: true,
    });
  });

  test('T11.5 /login renders the 2-step OTP form (regression for Polish WU v6)', async ({ page }) => {
    await page.goto('/backoffice/login');
    await expect(page.getByTestId('login-email')).toBeVisible();
    await expect(page.getByTestId('login-request-otp')).toBeVisible();
    await page.screenshot({
      path: 'e2e/lookfeel/artifacts/login-v3.png',
      fullPage: true,
    });
  });
});