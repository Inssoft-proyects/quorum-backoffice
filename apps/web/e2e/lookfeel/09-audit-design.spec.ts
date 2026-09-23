import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loginAs } from './helpers/login';

/**
 * T9 — Auditoría redesign (maquette v2).
 *
 * Asserts the redesign of /backoffice/audit against the InecConecta
 * maquette v2 pattern replicated from /dispositivos (T8) and /marbetes
 * (T6).
 *
 * Source-of-truth files (read once during authoring of this spec):
 *   - app/(authed)/audit/_components/audit-page-client.tsx
 *       (H1 "Auditoría", 4 MetricCard buttons with aria-pressed:
 *        Total / Marbetes / Dispositivos / Autenticación, plus the
 *        "Autenticación" card carries a danger pill when login-failed
 *        entries exist in the in-memory list)
 *   - app/(authed)/audit/_components/audit-filters.tsx
 *       (search input inside the .inventory-search shell, structured
 *        filters in a separate .grid row)
 *   - app/(authed)/audit/_components/audit-table.tsx
 *       (AUD-#### badges from padded e.id, SortHeader for the ID and
 *        Fecha columns, the full AuditAction enum (12 values) mapped
 *        to StatusChip variants)
 *
 * Modeled after `08-dispositivos-design.spec.ts` and
 * `06-marbetes-design.spec.ts`. Mirrors the exact-prefix pattern for
 * metric cards (`getByRole('button', { name: /^Total\b/ })`) so the
 * card label "Marbetes" does not collide with the row chip text for
 * the `marbete.create` action.
 *
 * The screenshot from T9.1 becomes the visual artefact for design
 * review at
 *   apps/web/e2e/lookfeel/artifacts/screenshots/audit-v2-design.png
 *
 * Runs against the LIVE production URL (same pattern as
 * `06-marbetes-design.spec.ts` — the `baseURL` in
 * `playwright.config.ts` points at https://quorum.asistentepro.mx).
 */
test.describe('T9 — audit design v2', () => {
  test('T9.1 page renders the 4 metric cards from the maquette', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/backoffice/audit');

    // Page header (H1).
    await expect(
      page.getByRole('heading', { name: 'Auditoría' }),
    ).toBeVisible();

    // Metric cards. Use exact-prefix matching so the card label
    // "Marbetes" does not collide with the row chip "marbete.create".
    await expect(
      page.getByRole('button', { name: /^Total\b/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /^Marbetes\b/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /^Dispositivos\b/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /^Autenticación\b/ }),
    ).toBeVisible();

    // Capture screenshot for design review. Playwright does not
    // auto-create parent directories; create the artefacts dir first.
    const screenshotPath =
      'e2e/lookfeel/artifacts/screenshots/audit-v2-design.png';
    mkdirSync(dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });
  });

  test('T9.2 table shows AUD-#### ID badges + action StatusChips', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/backoffice/audit');

    // Race the row list against the empty state — production seed
    // may have zero audit entries.
    const firstRow = page.locator('[data-testid^="audit-row-"]').first();
    const hasRows = await firstRow
      .waitFor({ state: 'visible', timeout: 2_000 })
      .then(() => true)
      .catch(() => false);

    if (!hasRows) {
      await expect(page.getByTestId('empty-state')).toBeVisible();
      test.skip(
        true,
        'production seed has zero audit entries in this run; empty state asserted',
      );
      return;
    }

    // Row-level assertions. Each row carries an IdBadge with the
    // AUD-#### text padded to 4 digits.
    const rowLocator = page.locator('[data-testid^="audit-row-"]');
    expect(await rowLocator.count()).toBeGreaterThan(0);

    await expect(page.getByText(/^AUD-\d{4}$/).first()).toBeVisible();

    // Action column renders a StatusChip — text is the AuditAction
    // value (e.g. "marbete.create"). Assert at least one such chip
    // is present without depending on a specific variant.
    const actionChip = page
      .locator('[data-testid^="audit-row-"]')
      .first()
      .locator('.chip')
      .first();
    await expect(actionChip).toBeVisible();
  });

  test('T9.3 typing in the search shell updates the URL to ?search=...', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/backoffice/audit');

    // The search input is the only input inside the .inventory-search
    // shell (the structured filters live in a separate .grid row).
    const searchInput = page.getByTestId('filter-search');
    await expect(searchInput).toBeVisible();

    // Sanity: clean URL with no search param.
    expect(new URL(page.url()).searchParams.get('search')).toBeNull();

    await searchInput.fill('marbete');
    await page.waitForURL(/search=marbete/, { timeout: 5_000 });
  });

  test('T9.4 clicking the Fecha SortHeader cycles descending → ascending', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/backoffice/audit');

    // The SortHeader for the Fecha column is wired by
    // `data-testid="sort-occurredAt"`. Assert the initial state is
    // "none" (no sort applied), then click and verify the cycle.
    const sortHeader = page.locator('[data-testid="sort-occurredAt"]');
    await expect(sortHeader).toBeVisible();
    await expect(sortHeader).toHaveAttribute('data-sort-direction', 'none');

    await sortHeader.click();
    await expect(sortHeader).toHaveAttribute('data-sort-direction', 'descending');

    await sortHeader.click();
    await expect(sortHeader).toHaveAttribute('data-sort-direction', 'ascending');
  });

  test('T9.5 auditor role also sees the 4 metric cards (RBAC reach)', async ({ page }) => {
    await loginAs(page, 'auditor');
    await page.goto('/backoffice/audit');

    // Auditor role passes the page-server gate (auditor+) and renders
    // the redesigned shell identically to admin.
    await expect(
      page.getByRole('heading', { name: 'Auditoría' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /^Total\b/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /^Marbetes\b/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /^Dispositivos\b/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /^Autenticación\b/ }),
    ).toBeVisible();
  });

  test('T9.6 operator role is redirected to /dashboard when visiting /audit', async ({ page }) => {
    await loginAs(page, 'operator');
    // The page-server gate redirects operator to /dashboard because
    // hasAtLeastRole(operator, auditor) is false (operator=1 < auditor=2).
    await page.goto('/backoffice/audit');
    await page.waitForURL(/\/dashboard/, { timeout: 5_000 });
    expect(page.url()).toContain('/dashboard');
  });
});
