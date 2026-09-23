import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/login';

/**
 * T6 — Marbetes redesign (maquette v2).
 *
 * Mocks the production environment to verify the redesigned
 * /backoffice/marbetes screen renders correctly under the maquette:
 *   - new header with two top CTAs
 *   - 4 metric cards in a grid (Total / Disponibles / Asignados / Por atender)
 *   - redesigned table with CRD badges + masked numbers + status chips
 *   - 3 redesigned dialogs (Agregar / Revelar / Baja)
 *
 * The screenshot captured by the first test becomes the visual
 * artefact for the design review (`marbetes-v2-design.png`).
 */
test.describe('T6 — marbetes design v2', () => {
  test('renders the redesigned inventory page with all 4 metric cards', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/backoffice/marbetes');

    await expect(
      page.getByRole('heading', { name: 'Inventario de marbetes' }),
    ).toBeVisible();
    await expect(page.getByText('Total')).toBeVisible();
    await expect(page.getByText('Disponibles')).toBeVisible();
    await expect(page.getByText('Asignados')).toBeVisible();
    await expect(page.getByText('Por atender')).toBeVisible();

    await page.screenshot({
      path: 'e2e/lookfeel/artifacts/screenshots/marbetes-v2-design.png',
      fullPage: true,
    });
  });

  test('table shows CRD badges + masked numbers + status chips', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/backoffice/marbetes');

    // CRD badges
    await expect(page.getByText(/CRD-\d{4}/).first()).toBeVisible();

    // Masked numbers (N***NNN)
    await expect(page.getByText(/\d\*\*\*\d{2,3}/).first()).toBeVisible();

    // Privacy chip "Oculto"
    await expect(page.getByText('Oculto').first()).toBeVisible();
  });

  test('Add marbete dialog opens and has the right structure', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/backoffice/marbetes');

    await page.getByRole('button', { name: /Agregar marbete/i }).click();
    await expect(page.getByTestId('add-marbete-title')).toBeVisible();
    await expect(page.getByLabel(/Número de marbete/i)).toBeVisible();
    await expect(page.getByText(/Solo dígitos numéricos/i)).toBeVisible();

    // Save button starts disabled
    const save = page.getByTestId('add-marbete-submit');
    await expect(save).toBeDisabled();
  });

  test('Reveal dialog opens with motivo select', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/backoffice/marbetes');

    await page.getByRole('button', { name: /^Revelar$/ }).first().click();
    await expect(page.getByTestId('reveal-marbete-title')).toBeVisible();
    await expect(page.getByTestId('reveal-reason-select')).toBeVisible();
  });

  test('Revoke (Baja) dialog opens with motivo select', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/backoffice/marbetes');

    await page.getByRole('button', { name: /^Baja$/ }).first().click();
    await expect(page.getByTestId('revoke-marbete-title')).toBeVisible();
    await expect(page.getByTestId('deactivate-reason-select')).toBeVisible();
  });
});
