import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loginAs } from './helpers/login';

/**
 * T8 — Dispositivos redesign (maquette v2).
 *
 * Asserts the redesign of /backoffice/dispositivos against the InecConecta
 * maquette at diseno/maqueta_Inec/Inec/inventario-credenciales.html.
 *
 * Source-of-truth files (read once during authoring of this spec):
 *   - app/(authed)/dispositivos/_components/dispositivos-page-client.tsx
 *       (H1 "Inventario de dispositivos", 4 MetricCard buttons with
 *        aria-pressed, admin-gated "Registrar dispositivo" button with
 *        data-testid="open-create")
 *   - app/(authed)/dispositivos/_components/dispositivos-filters.tsx
 *       (H2 "Dispositivos registrados" + status <select> with
 *        data-testid="filter-status" but no associated <label> —
 *        accessible via testid, NOT getByLabel)
 *   - app/(authed)/dispositivos/_components/create-dialog.tsx
 *       (data-testid="create-dialog" + Label "Serial" attached to
 *        id="create-serial", so getByLabel(/serial/i) works)
 *   - app/(authed)/dispositivos/_components/dispositivos-table.tsx
 *       (DIS-#### badges from padded d.id, StatusChip labels are the
 *        singular "Activo" / "Revocado" — distinct from the metric card
 *        plural labels "Activos" / "Revocados")
 *
 * Modeled after `06-marbetes-design.spec.ts`. Mirrors the existing
 * exact-prefix pattern for metric cards (`getByRole('button', { name:
 * /^Total\b/ })`) so the same string content does not collide with
 * other page copy (e.g. the chip "Filtrar" or the donut chart caption).
 *
 * The screenshot from the first test becomes the visual artefact for
 * design review at
 *   apps/web/e2e/lookfeel/artifacts/screenshots/dispositivos-v2-design.png
 *
 * Runs against the LIVE production URL (same pattern as
 * `06-marbetes-design.spec.ts` — the `baseURL` in
 * `playwright.config.ts` points at https://quorum.asistentepro.mx).
 */
test.describe('T8 — dispositivos design v2', () => {
  test('T8.1 page renders the 4 metric cards from the maquette', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/backoffice/dispositivos');

    // Page header (H1) + filters row heading (H2).
    await expect(
      page.getByRole('heading', { name: 'Inventario de dispositivos' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Dispositivos registrados' }),
    ).toBeVisible();

    // Metric cards. Use exact-prefix matching (mirrors 06-marbetes) so
    // plural substrings like "Activos" do not bleed into singular
    // StatusChip assertions elsewhere on the page.
    await expect(
      page.getByRole('button', { name: /^Total\b/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /^Activos\b/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /^Revocados\b/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /^Sin marca\b/ }),
    ).toBeVisible();

    // Capture screenshot for design review. Playwright does not
    // auto-create parent directories; create the artefacts dir first.
    const screenshotPath =
      'e2e/lookfeel/artifacts/screenshots/dispositivos-v2-design.png';
    mkdirSync(dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });
  });

  test('T8.2 table shows DIS-#### ID badges + serial + status chips', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/backoffice/dispositivos');

    // Wait for the page shell to settle before deciding which branch to
    // take. The status select is always rendered; race the row list
    // against the empty state.
    await expect(page.getByTestId('filter-status')).toBeVisible();

    const firstRow = page.locator('[data-testid^="dispositivo-row-"]').first();
    const hasRows = await firstRow
      .waitFor({ state: 'visible', timeout: 2_000 })
      .then(() => true)
      .catch(() => false);

    if (!hasRows) {
      // Production seed has zero dispositivos (or rows are filtered out
      // by some state). Row-level assertions do not apply; assert the
      // empty state and skip per the task's "graceful guard" rule.
      await expect(page.getByTestId('empty-state')).toBeVisible();
      test.skip(
        true,
        'production seed has zero dispositivos in this run; empty state asserted',
      );
      return;
    }

    // Row-level assertions. The chip labels are singular ("Activo" /
    // "Revocado") and do NOT collide with the plural metric card labels
    // ("Activos" / "Revocados") or the plural select option labels.
    const rowLocator = page.locator('[data-testid^="dispositivo-row-"]');
    await expect(rowLocator.first()).toBeVisible();
    expect(await rowLocator.count()).toBeGreaterThan(0);

    await expect(page.getByText(/^DIS-\d{4}$/).first()).toBeVisible();

    await expect(
      page.getByText(/^(Activo|Revocado)$/).first(),
    ).toBeVisible();

    // At least one row has a non-empty serial in the credential cell.
    // The table renders the serial directly in `<td
    // class="data-table__credential">{d.serialNumber}</td>` — no
    // masking, no placeholder. Assert the cell carries non-whitespace
    // text without depending on a specific SN-XXXX-NNNN format.
    const serialCell = page.locator('.data-table__credential').first();
    const serialText = (await serialCell.textContent())?.trim() ?? '';
    expect(serialText.length).toBeGreaterThan(0);
  });

  test('T8.3 Registrar dispositivo dialog opens (admin-gated)', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/backoffice/dispositivos');

    // The header action button wired by `data-testid="open-create"`
    // has visible text "Registrar dispositivo".
    await page.getByRole('button', { name: /Registrar dispositivo/i }).click();

    // Dialog is the only `data-testid="create-dialog"` on this route.
    await expect(page.getByTestId('create-dialog')).toBeVisible();

    // The serial input has an associated `<Label htmlFor="create-serial">Serial</Label>`
    // (verified in create-dialog.tsx), so `getByLabel(/serial/i)`
    // resolves through the for/id association. The match is on the
    // bare label "Serial" — NOT "número de serie" or "Serial number".
    await expect(page.getByLabel(/^Serial$/i)).toBeVisible();

    // Close with Escape (Radix Dialog handles the Escape key).
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('create-dialog')).not.toBeVisible();
  });

  test('T8.4 filter select updates the URL to ?status=active', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/backoffice/dispositivos');

    // Sanity: clean URL with no status param.
    expect(new URL(page.url()).searchParams.get('status')).toBeNull();

    // The status <select> has NO associated <Label> (verified in
    // dispositivos-filters.tsx) — getByLabel(/estado/i) cannot find
    // it, so use the data-testid wired by the component.
    await expect(page.getByTestId('filter-status')).toBeVisible();
    await page
      .getByTestId('filter-status')
      .selectOption({ label: 'Activos' });

    // The filtros onChange fires `router.replace('/dispositivos?status=active')`;
    // with `basePath: '/backoffice'` the final URL is
    // `/backoffice/dispositivos?status=active`.
    await page.waitForURL(/status=active/, { timeout: 5_000 });
  });

  test('T8.5 operator cannot see Registrar dispositivo button', async ({ page }) => {
    await loginAs(page, 'operator');
    await page.goto('/backoffice/dispositivos');

    // Page rendered; the filters shell is always visible.
    await expect(page.getByTestId('filter-status')).toBeVisible();

    // The "Registrar dispositivo" button is gated by `isAdmin`; for the
    // operator role the wrapping `inventory-header__actions` div is
    // unmounted entirely. Asserting `toHaveCount(0)` is the cheapest,
    // flakiest-safe assertion (the button never appears in the DOM).
    await expect(
      page.getByRole('button', { name: /Registrar dispositivo/i }),
    ).toHaveCount(0);
  });
});
