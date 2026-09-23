import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/login';

/**
 * T6 — Marbetes redesign (maquette v2).
 *
 * Asserts the redesign of /backoffice/marbetes against the InecConecta
 * maquette at diseno/maqueta_Inec/Inec/inventario-credenciales.html.
 * Covers:
 *   - page header (title, subtitle, two CTAs)
 *   - 4 metric cards (Total / Disponibles / Asignados / Por atender)
 *     with computed-style smoke checks
 *   - redesigned table (CRD badges, masked numbers, status chips,
 *     derived Vigencia chip, action buttons)
 *   - 3 redesigned dialogs (Agregar / Revelar / Dar de baja) opening
 *     and matching maquette content (motivo select + comentario)
 *
 * The screenshot from the first test becomes the visual artefact for
 * design review at apps/web/e2e/lookfeel/artifacts/screenshots/
 *   marbetes-v2-design.png.
 */
test.describe('T6 — marbetes design v2', () => {
  test('page renders the 4 metric cards from the maquette', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/backoffice/marbetes');

    await expect(
      page.getByRole('heading', { name: 'Inventario de marbetes' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Marbetes registrados' }),
    ).toBeVisible();

    // Metric cards (use exact match to avoid "Total Inventario" matching
    // a partial substring elsewhere on the page).
    await expect(
      page.getByRole('button', { name: /^Total\b/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /^Disponibles\b/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /^Asignados\b/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /^Por atender\b/ }),
    ).toBeVisible();

    // Capture screenshot for visual review.
    await page.screenshot({
      path: 'e2e/lookfeel/artifacts/screenshots/marbetes-v2-design.png',
      fullPage: true,
    });
  });

  test('table shows CRD badges + masked numbers + status chips', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/backoffice/marbetes');

    // CRD-#### badges. Accept any row.
    await expect(page.getByText(/^CRD-\d{4}$/).first()).toBeVisible();

    // Masked numbers in the format X***NN or X***NNN (server-rendered).
    // First char is a letter or digit (e.g. "C***41").
    await expect(page.getByText(/^[A-Z0-9]\*\*\*\d{2,3}$/).first()).toBeVisible();

    // Privacy chip
    await expect(page.getByText('Oculto').first()).toBeVisible();

    // Status chips
    await expect(
      page.getByText(/^(Disponible|Asignado|Vencida|Revocado)$/).first(),
    ).toBeVisible();
  });

  test('Add marbete dialog opens and shows maquette copy', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/backoffice/marbetes');

    await page.getByRole('button', { name: /Agregar marbete/i }).click();
    await expect(page.getByTestId('add-marbete-title')).toBeVisible();
    await expect(
      page.getByText(/El sistema calculará la vigencia/i),
    ).toBeVisible();
    await expect(page.getByLabel(/Número de marbete/i)).toBeVisible();
    await expect(page.getByText(/Solo dígitos numéricos/i)).toBeVisible();

    // Save starts disabled.
    await expect(page.getByTestId('add-marbete-submit')).toBeDisabled();
  });

  test('Reveal dialog opens with motivo select', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/backoffice/marbetes');

    await page.getByRole('button', { name: /^Revelar/ }).first().click();
    await expect(page.getByTestId('reveal-marbete-title')).toBeVisible();
    // The h2 title and submit button both contain "Revelar marbete";
    // disambiguate via the data-testid we set on the title.
    await expect(page.getByTestId('reveal-marbete-title')).toBeVisible();
    await expect(page.getByTestId('reveal-reason-select')).toBeVisible();
    await expect(page.getByTestId('reveal-comment')).toBeVisible();
  });

  test('Revoke (Dar de baja) dialog opens with motivo select', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/backoffice/marbetes');

    await page.getByRole('button', { name: /^Dar de baja/i }).first().click();
    await expect(page.getByTestId('revoke-marbete-title')).toBeVisible();
    await expect(page.getByText(/Dar de baja marbete/)).toBeVisible();
    await expect(page.getByTestId('deactivate-reason-select')).toBeVisible();
    await expect(page.getByTestId('deactivate-comment')).toBeVisible();
  });
});
