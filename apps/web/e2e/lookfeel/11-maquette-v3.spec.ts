import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/login';

/**
 * Polish WU v6 / B7 — maquette v3 visual regression.
 *
 * Drives the live BackOffice host to verify that the rendered screens
 * match the HTML canon in `diseno/maqueta_Inec/Inec/inventario-credenciales.html`.
 *
 * Each test loads a screen, asserts the heading + 4 metric labels, and
 * captures a screenshot into `apps/web/e2e/lookfeel/artifacts/` for
 * manual visual diff against the maquette PNGs.
 *
 * Authed screens route through the env-gated `loginAs` helper, which
 * safely `test.skip()`s when the runner is missing explicit
 * `E2E_OPERATOR_USERNAME` + `E2E_OPERATOR_OTP` values; the helper
 * never invents credentials and never assumes an email. The legacy
 * 2-step email + request-code flow that this file used to drive is
 * gone — the BackOffice now logs in with a single-step
 * `Usuario` + `Código dinámico` form (see
 * `apps/web/app/login/login-form-otp.tsx`).
 *
 * The `/login` assertions in T11.5 reflect that single-step form.
 */

test.describe('Maquette v3 visual regression (Polish WU v6 / B7)', () => {
  test('T11.1 /marbetes renders the 4 metric cards + heading from the maquette', async ({ page }) => {
    await loginAs(page, 'operator');
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
    await loginAs(page, 'operator');
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
    await loginAs(page, 'operator');
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
    await loginAs(page, 'operator');
    await page.waitForURL(new RegExp('/backoffice/dashboard'), { timeout: 15_000 });
    await page.screenshot({
      path: 'e2e/lookfeel/artifacts/dashboard-v3.png',
      fullPage: true,
    });
  });

  test('T11.5 /login renders the single-step Usuario + Código dinámico form', async ({ page }) => {
    await page.goto('/backoffice/login');
    // Regression for Polish WU v6: the legacy 2-step email +
    // request-code flow is gone. The form now exposes exactly two
    // inputs (Usuario + Código dinámico) and one submit button.
    await expect(page.getByLabel('Usuario')).toBeVisible();
    await expect(page.getByTestId('login-username')).toBeVisible();
    await expect(page.getByLabel('Código dinámico')).toBeVisible();
    await expect(page.getByTestId('login-otp')).toBeVisible();
    await expect(page.getByTestId('login-submit')).toBeVisible();
    // The legacy affordances must NOT come back.
    await expect(page.getByTestId('login-email')).toHaveCount(0);
    await expect(page.getByTestId('login-request-otp')).toHaveCount(0);
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await page.screenshot({
      path: 'e2e/lookfeel/artifacts/login-v3.png',
      fullPage: true,
    });
  });
});
