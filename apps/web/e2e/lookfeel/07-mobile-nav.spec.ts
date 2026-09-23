import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/login';

/**
 * T7 — Mobile navigation drawer (RESP-001).
 *
 * Exercises the MobileNav hamburger trigger + left-side drawer shipped
 * in commit `8d31b0b feat(web): collapse AppShell on mobile + left drawer
 * for nav (RESP-001)`. The desktop sidebar (`<aside>`) is hidden on
 * viewports < 768px (Tailwind `md`); the hamburger trigger lives in the
 * topbar (`md:hidden`) and opens a Radix Dialog drawer with the same
 * nav items as the desktop sidebar.
 *
 * Runs against the LIVE production URL (same pattern as
 * `06-marbetes-design.spec.ts`). The Playwright config defaults to a
 * desktop viewport (1280×800); we override per-test with a mobile
 * viewport of 360×800 via `test.use` to validate the responsive shell
 * against the smallest design-system viewport (360 is the bottom of the
 * InecConecta matrix; audit T4 found horizontal overflow up to ~689px
 * at this width pre-fix).
 *
 * Covers:
 *   - T7.1 hamburger trigger is visible on mobile, sidebar is hidden
 *   - T7.2 drawer opens with role="dialog" and lists all admin nav items
 *         (Inicio, Marbetes, Dispositivos, Auditoría)
 *         Note: Radix Dialog 1.1.23 does not auto-set the modal ARIA
 *         attribute on Content (verified against node_modules);
 *         role="dialog" + focus trap are the modal contract.
 *   - T7.3 link click navigates to /marbetes and closes the drawer;
 *         captures a screenshot for design review
 *   - T7.4 ESC closes the drawer
 *   - T7.5 operator role does not see the Auditoría link
 */
test.describe('T7 — mobile nav drawer', () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test('T7.1 hamburger visible on mobile, desktop sidebar hidden', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/backoffice/dashboard');

    const trigger = page.getByTestId('mobile-nav-trigger');
    await expect(trigger).toBeVisible();

    // The desktop sidebar must not occupy any flow on a 360px viewport.
    // Accept either display:none (Tailwind `hidden` class) or a 0-width
    // box (defensive against a future regression where the class is
    // moved but the element stays in the DOM).
    const sidebarState = await page.evaluate(() => {
      const aside = document.querySelector('aside') as HTMLElement | null;
      if (!aside) return { display: 'absent', width: 0 };
      const rect = aside.getBoundingClientRect();
      return { display: getComputedStyle(aside).display, width: rect.width };
    });
    expect(
      sidebarState.display === 'none' || sidebarState.width === 0,
      `desktop <aside> should be hidden on mobile; got display=${sidebarState.display}, width=${sidebarState.width}`,
    ).toBe(true);
  });

  test('T7.2 drawer opens with role=dialog and lists all admin nav items', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/backoffice/dashboard');

    await page.getByTestId('mobile-nav-trigger').click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Admin sees all four nav items.
    await expect(page.getByTestId('mobile-nav-link-dashboard')).toBeVisible();
    await expect(page.getByTestId('mobile-nav-link-marbetes')).toBeVisible();
    await expect(page.getByTestId('mobile-nav-link-dispositivos')).toBeVisible();
    await expect(page.getByTestId('mobile-nav-link-audit')).toBeVisible();
  });

  test('T7.3 link click navigates and closes the drawer', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/backoffice/dashboard');

    await page.getByTestId('mobile-nav-trigger').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await page.getByTestId('mobile-nav-link-marbetes').click();

    // Navigation lands on /marbetes (the basePath is /backoffice, so the
    // pathname ends with /backoffice/marbetes; we check the tail).
    await page.waitForURL(/\/marbetes(?:[/?#]|$)/, { timeout: 10_000 });
    expect(page.url()).toMatch(/\/marbetes(?:[/?#]|$)/);

    // Drawer is hidden after navigation. Radix applies a `data-state`
    // attribute on the content element; we also accept the broader
    // Playwright visibility check.
    await expect(dialog).toBeHidden();

    // Screenshot for design review.
    await page.screenshot({
      path: 'e2e/lookfeel/artifacts/screenshots/mobile-nav-mar.png',
      fullPage: true,
    });
  });

  test('T7.4 ESC closes the drawer', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/backoffice/dashboard');

    await page.getByTestId('mobile-nav-trigger').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('T7.5 operator role does not see the Auditoría link in the drawer', async ({ page }) => {
    await loginAs(page, 'operator');
    await page.goto('/backoffice/dashboard');

    await page.getByTestId('mobile-nav-trigger').click();
    await expect(page.getByRole('dialog')).toBeVisible();

    // Operator role (hierarchy 1) must not expose the Auditoría link, which is gated to auditor+ (hierarchy 2) per RBAC.
    await expect(page.getByTestId('mobile-nav-link-audit')).toHaveCount(0);
  });
});
