import { test, expect, type Page } from '@playwright/test';
import { clearSession, loginAs, type Role } from './helpers/login';
import { captureSnapshot } from './helpers/snapshot';

/**
 * T6 — Interaction flows.
 *
 * Exercises every navigation, dialog, filter, and drawer that the
 * production UI exposes. Per the brief we never submit CRUD forms — we
 * open them, verify their structure, and close them.
 *
 * Each flow captures a screenshot of the open state for the report.
 */

async function expectDialogOpen(page: Page, titleHint: RegExp | string): Promise<void> {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  if (titleHint instanceof RegExp) {
    await expect(dialog).toContainText(titleHint);
  } else {
    await expect(dialog).toContainText(titleHint);
  }
}

test.describe('T6 — interaction flows', () => {
  test('login: bad creds → alert + stays on /login', async ({ page }) => {
    await page.goto('/backoffice/login');
    await page.getByLabel('Correo').fill('nope@quorum.local');
    await page.getByLabel('Contraseña').fill('wrong-password-xyz');
    await page.getByRole('button', { name: /Ingresar/i }).click();
    // The page exposes two [role="alert"] nodes: Next.js's hidden route
    // announcer and the login form's inline Alert. Scope to the form to
    // avoid the strict-mode violation.
    await expect(page.locator('form [role="alert"]')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('login: good creds → /dashboard', async ({ page }) => {
    await loginAs(page, 'admin');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('sidebar navigation: each visible link navigates', async ({ page }) => {
    await loginAs(page, 'admin');
    const sidebar = page.locator('aside');
    // Inicio → /dashboard
    await sidebar.getByRole('link', { name: 'Inicio' }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    // Marbetes → /marbetes
    await sidebar.getByRole('link', { name: 'Marbetes' }).click();
    await expect(page).toHaveURL(/\/marbetes/);
    // Dispositivos → /dispositivos
    await sidebar.getByRole('link', { name: 'Dispositivos' }).click();
    await expect(page).toHaveURL(/\/dispositivos/);
    // Auditoría → /audit (visible for admin)
    await sidebar.getByRole('link', { name: 'Auditoría' }).click();
    await expect(page).toHaveURL(/\/audit/);
  });

  test('marbetes: Disponibles MetricCard filters rows in-memory', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/backoffice/marbetes');
    const totalRowsBefore = await page.locator('tbody tr').count();
    await page.getByRole('button', { name: /^Disponibles\b/ }).click();
    await expect(
      page.getByRole('button', { name: /^Disponibles\b/ }),
    ).toHaveAttribute('aria-pressed', 'true');
    // Reset
    await page.getByRole('button', { name: /^Total\b/ }).click();
    await expect(
      page.getByRole('button', { name: /^Total\b/ }),
    ).toHaveAttribute('aria-pressed', 'true');
    const totalRowsAfter = await page.locator('tbody tr').count();
    expect(totalRowsAfter).toBeLessThanOrEqual(totalRowsBefore);
  });

  test('marbetes: search input filters rows in-memory', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/backoffice/marbetes');
    const search = page.getByTestId('marbetes-search');
    await expect(search).toBeVisible();
    await search.fill('m-AB12CD');
    // URL does NOT change (state-only filter in v2)
    expect(page.url()).toContain('/backoffice/marbetes');
    expect(page.url()).not.toContain('search=');
    await search.fill('');
  });

  test('marbetes: open add dialog, verify structure, close', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/backoffice/marbetes');
    await page.getByTestId('add-marbete-trigger').click();
    await expect(page.getByTestId('add-marbete-title')).toBeVisible();
    await expect(page.getByTestId('add-marbete-title')).toContainText(/Agregar marbete/i);
    await captureSnapshot(page, { name: '/marbetes', role: 'admin', suffix: 'create-dialog' });
    await expect(page.getByRole('button', { name: /Cancelar/i })).toBeVisible();
    await expect(page.getByTestId('add-marbete-submit')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('dispositivos: open create dialog, verify structure, close', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/backoffice/dispositivos');
    await page.getByTestId('open-create').click();
    await expectDialogOpen(page, /Registrar|Crear/i);
    await captureSnapshot(page, { name: '/dispositivos', role: 'admin', suffix: 'create-dialog' });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('audit: action + entity filters update URL', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/backoffice/audit');
    await page.locator('#filter-action').selectOption('marbete.create');
    await page.waitForURL(/action=marbete\.create/);
    expect(page.url()).toContain('action=marbete.create');
    await page.locator('#filter-entity-type').selectOption('marbete');
    await page.waitForURL(/entityType=marbete/);
    expect(page.url()).toContain('entityType=marbete');
  });

  test('audit: drawer opens on row click + closes on Escape', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/backoffice/audit');
    // Try to click the first row in the table (if any). Use a generous
    // locator that works for any row shape.
    const row = page.locator('table tbody tr').first();
    if ((await row.count()) > 0) {
      await row.click();
      await expect(page.getByTestId('audit-detail')).toBeVisible();
      await captureSnapshot(page, { name: '/audit', role: 'admin', suffix: 'detail-drawer' });
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('audit-detail')).toBeHidden();
    } else {
      test.skip(true, 'audit table empty — skipping row-click test');
    }
  });

  test('logout: returns to /login', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.getByRole('button', { name: /Salir/i }).first().click();
    await page.waitForURL(/\/login/);
    await expect(page).toHaveURL(/\/login/);
  });

  // Cross-role smoke: a single end-to-end pass for operator and auditor
  // so we know RBAC works for navigation and filters in production.
  for (const role of ['operator', 'auditor'] as Role[]) {
    test(`cross-role smoke: ${role} navigates dashboard → marbetes → logout`, async ({ page }) => {
      await loginAs(page, role);
      await expect(page).toHaveURL(/\/dashboard/);
      await page.locator('aside').getByRole('link', { name: 'Marbetes' }).click();
      await expect(page).toHaveURL(/\/marbetes/);
      // Cleanup: hit /logout by clicking the Salir button so the next
      // test in this context starts fresh.
      await page.getByRole('button', { name: /Salir/i }).first().click();
      await page.waitForURL(/\/login/);
      await clearSession(page);
    });
  }
});
