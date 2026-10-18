import { test, expect, type Page } from '@playwright/test';

/**
 * Real-browser verification of the cosmetic migration.
 *
 * Covers exactly what jsdom cannot: that the replaced primitives render and
 * move in Chromium, that the login hand-off survives the change, and that no
 * cross-origin request is rejected.
 *
 * The stub API accepts only OTP `ABC123` and only for username `admin`.
 */

const USERNAME = 'admin';
const OTP = 'ABC123';

type ConsoleIssue = { type: string; text: string };

function collectIssues(page: Page): ConsoleIssue[] {
  const issues: ConsoleIssue[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      issues.push({ type: message.type(), text: message.text() });
    }
  });
  page.on('pageerror', (error) => {
    issues.push({ type: 'pageerror', text: error.message });
  });
  return issues;
}

function corsIssues(issues: ConsoleIssue[]): ConsoleIssue[] {
  return issues.filter((issue) =>
    /cors|origen cruzado|cross-origin|access-control|failed to fetch/i.test(issue.text),
  );
}

async function fillLogin(page: Page, otp = OTP) {
  await page.goto('/backoffice/login');
  const username = page.getByLabel('Usuario');
  await username.click();
  await username.fill(USERNAME);
  // The OTP is six independent boxes: focus the first one and let the
  // component auto-advance through the rest.
  await page.getByTestId('login-otp').locator('input').first().click();
  await page.keyboard.type(otp, { delay: 20 });
}

async function login(page: Page) {
  await fillLogin(page);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/backoffice\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Inicio' })).toBeVisible();
}

test.describe('Cosmetic migration — browser smoke', () => {
  test('login form exposes the floating label and blocks submission until valid', async ({
    page,
  }) => {
    const issues = collectIssues(page);
    await page.goto('/backoffice/login');

    const username = page.getByLabel('Usuario');
    await expect(username).toBeVisible();
    await expect(page.getByTestId('login-submit')).toBeDisabled();

    // The placeholder only exists once the label has been raised.
    expect(await username.getAttribute('placeholder')).toBeNull();
    await username.click();
    await expect(username).toHaveAttribute('placeholder', 'admin');

    await username.fill(USERNAME);
    await expect(username).toHaveValue(USERNAME);
    expect(corsIssues(issues)).toEqual([]);
  });

  test('wrong OTP surfaces the error banner and keeps the form usable', async ({ page }) => {
    const issues = collectIssues(page);
    await fillLogin(page, 'ZZZZZZ');
    await page.getByTestId('login-submit').click();

    const alert = page.getByTestId('login-error');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/incorrecto/i);
    await expect(page).toHaveURL(/\/backoffice\/login$/);
    expect(corsIssues(issues)).toEqual([]);
  });

  test('valid OTP logs in against the API and lands on the dashboard', async ({ page }) => {
    const issues = collectIssues(page);
    await login(page);

    await expect(page.getByTestId('dashboard-card-marbetes')).toBeVisible();
    // Value Flash renders the count as text without duplicating it.
    await expect(page.getByTestId('dashboard-card-marbetes')).toContainText('95');
    expect(corsIssues(issues)).toEqual([]);
  });

  test('marbete create dialog opens, accepts a floating-label value and closes on Escape', async ({
    page,
  }) => {
    const issues = collectIssues(page);
    await login(page);
    await page.goto('/backoffice/marbetes');
    await expect(page.getByRole('heading', { name: /Marbetes/i }).first()).toBeVisible();

    await page.getByTestId('add-marbete-trigger').click();
    const dialog = page.getByTestId('add-marbete-dialog');
    await expect(dialog).toBeVisible();

    const code = dialog.getByLabel('Número de marbete');
    await code.fill('VALIDO-2609982468');
    await expect(code).toHaveValue('VALIDO-2609982468');

    // OTP group is reachable and typed character by character.
    await dialog.getByRole('group', { name: 'Código OTP' }).locator('input').first().click();
    await page.keyboard.type(OTP, { delay: 20 });
    await expect(
      dialog.getByRole('group', { name: 'Código OTP' }).locator('input').first(),
    ).toHaveValue('A');

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(corsIssues(issues)).toEqual([]);
  });

  test('pagination moves through fixed slots without leaving the page', async ({ page }) => {
    const issues = collectIssues(page);
    await login(page);
    await page.goto('/backoffice/marbetes');

    await expect(page.getByTestId('pagination-page')).toHaveText('Página 1 de 10');
    await page.getByRole('button', { name: 'Página 3' }).click();
    await expect(page.getByTestId('pagination-page')).toHaveText('Página 3 de 10');
    await page.getByTestId('pagination-next').click();
    await expect(page.getByTestId('pagination-page')).toHaveText('Página 4 de 10');
    await page.getByTestId('pagination-prev').click();
    await expect(page.getByTestId('pagination-page')).toHaveText('Página 3 de 10');
    expect(corsIssues(issues)).toEqual([]);
  });

  test('mobile drawer opens from the trigger and closes on Escape', async ({ page }) => {
    const issues = collectIssues(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);

    const drawer = page.locator('[data-state="open"]').filter({ hasText: 'Menú principal' });
    await page.getByTestId('mobile-nav-trigger').click();
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId('mobile-nav-link-marbetes')).toBeVisible();

    await page.keyboard.press('Escape');
    // The panel is translated off-screen rather than unmounted, so the
    // observable contract is: closed state, out of the accessibility tree,
    // and focus returned to the trigger.
    const closed = page.locator('[data-state="closed"]').filter({ hasText: 'Menú principal' });
    await expect(closed).toHaveAttribute('aria-hidden', 'true');
    await expect(page.getByTestId('mobile-nav-trigger')).toBeFocused();
    expect(corsIssues(issues)).toEqual([]);
  });

  test('the browser calls the API on its own origin, never a hardcoded host', async ({ page }) => {
    // Regression guard for the deployed failure: a bundle built without
    // NEXT_PUBLIC_API_URL used to inline http://127.0.0.1:3100, so every
    // visitor's browser called its own machine and was blocked as
    // cross-origin. With the same-origin default every /api request must
    // resolve to the origin serving the page.
    const apiRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/v1/')) apiRequests.push(request.url());
    });

    await login(page);

    expect(apiRequests.length).toBeGreaterThan(0);
    for (const url of apiRequests) {
      expect(new URL(url).origin).toBe('http://127.0.0.1:3210');
    }
  });
});
