import { test, expect, type Page } from '@playwright/test';

/**
 * Browser verification of the UI canon requested in
 * `odd/tasks/backoffice-ui-canon.md` (S1, S2, S3, S4, S7).
 *
 * Runs in the deterministic cosmetic harness: real standalone build, stub API,
 * nothing real contacted. Each test pins one rule:
 *
 *   1. no control is extruded (no depth slab, no 3D tilt)      -> S1
 *   2. table screens spend at least 98% of the viewport height  -> S2
 *   3. the assignment screen no longer scrolls the document     -> S7
 *   4. the sidebar carries the mark and the `BackOffice` title  -> S3
 *   5. the sidebar collapses, expands and remembers it          -> S4
 */

const USERNAME = 'admin';
const OTP = 'ABC123';

async function login(page: Page) {
  await page.goto('/backoffice/login');
  const username = page.getByLabel('Usuario');
  await username.click();
  await username.fill(USERNAME);
  await page.getByTestId('login-otp').locator('input').first().click();
  await page.keyboard.type(OTP, { delay: 20 });
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/backoffice\/dashboard$/);
}

/** Reads every visible control and returns the ones that still look extruded. */
async function extrudedControls(page: Page) {
  return page.evaluate(() => {
    const offenders: string[] = [];
    const controls = document.querySelectorAll('button, a.btn, [role="button"]');

    for (const el of controls) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;

      // A depth slab is an absolutely positioned, aria-hidden child anchored
      // `top: Npx; bottom: 0` inside the button: the face travels over it.
      for (const child of el.children) {
        const cs = getComputedStyle(child);
        if (cs.position !== 'absolute' || child.getAttribute('aria-hidden') === null) continue;
        const top = parseFloat(cs.top);
        const spansWidth = Math.abs(child.getBoundingClientRect().width - box.width) < 2;
        if (top > 0 && spansWidth) offenders.push(`slab:${el.textContent?.trim().slice(0, 24)}`);
      }

      // The tilt uses rotateX/rotateY, which serialises as a 3D matrix. The
      // face lives in a motion span, so check the element and its children.
      const nodes = [el, ...el.querySelectorAll('span')];
      for (const node of nodes) {
        const cs = getComputedStyle(node);
        if (cs.transform.startsWith('matrix3d')) {
          offenders.push(`tilt:${el.textContent?.trim().slice(0, 24)}`);
          break;
        }
        if (cs.perspective !== 'none' && parseFloat(cs.perspective) > 0) {
          offenders.push(`perspective:${el.textContent?.trim().slice(0, 24)}`);
          break;
        }
      }
    }
    return [...new Set(offenders)];
  });
}

test.describe('UI canon — flat controls and the 98% viewport budget', () => {
  test('no control is extruded on the login, dashboard or inventory screens', async ({ page }) => {
    await page.goto('/backoffice/login');
    await expect(page.getByTestId('login-submit')).toBeVisible();
    expect(await extrudedControls(page)).toEqual([]);

    await login(page);
    expect(await extrudedControls(page)).toEqual([]);

    for (const route of ['/backoffice/marbetes', '/backoffice/dispositivos', '/backoffice/audit']) {
      await page.goto(route);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await extrudedControls(page), route).toEqual([]);
    }
  });

  test('the table screens spend at least 98% of the viewport height', async ({ page }) => {
    await login(page);
    for (const route of ['/backoffice/marbetes', '/backoffice/dispositivos', '/backoffice/audit']) {
      await page.goto(route);
      await expect(page.locator('.table-pagination')).toBeVisible();

      const measured = await page.evaluate(() => {
        const pagination = document.querySelector('.table-pagination')!.getBoundingClientRect();
        const main = document.querySelector('main')!;
        return {
          viewport: window.innerHeight,
          paginationBottom: pagination.bottom,
          pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
          mainScrolls: main.scrollHeight > main.clientHeight + 1,
        };
      });

      // S2: the dead band left below the pagination is at most 2% of the
      // viewport height, with a 1px tolerance for sub-pixel rounding.
      const deadBand = measured.viewport - measured.paginationBottom;
      const budget = measured.viewport * 0.02 + 1;
      expect(
        deadBand,
        `${route} leaves ${deadBand.toFixed(1)}px of dead space (budget ${budget.toFixed(1)}px)`,
      ).toBeLessThanOrEqual(budget);
      expect(measured.pageScrolls, `${route} must not scroll the document`).toBe(false);
      expect(measured.mainScrolls, `${route} must scroll inside the table`).toBe(false);
    }
  });

  test('the space above the page title matches the space below the table footer', async ({
    page,
  }) => {
    await login(page);
    for (const route of ['/backoffice/marbetes', '/backoffice/dispositivos', '/backoffice/audit']) {
      await page.goto(route);
      await expect(page.locator('.table-pagination')).toBeVisible();

      const measured = await page.evaluate(() => {
        const main = document.querySelector('main')!.getBoundingClientRect();
        const title = document.querySelector('.inventory-page h1')!.getBoundingClientRect();
        const pagination = document.querySelector('.table-pagination')!.getBoundingClientRect();
        return {
          above: +(title.top - main.top).toFixed(1),
          below: +(window.innerHeight - pagination.bottom).toFixed(1),
        };
      });

      // S9: one constant breathing space, above and below, so the page reads
      // centred instead of pushed down.
      expect(
        Math.abs(measured.above - measured.below),
        `${route} leaves ${measured.above}px above the title and ${measured.below}px below the footer`,
      ).toBeLessThanOrEqual(1);
    }
  });

  test('the summary cards share one geometry: equal heights, 8px gaps, no clipping', async ({
    page,
  }) => {
    await login(page);
    for (const route of [
      '/backoffice/dashboard',
      '/backoffice/marbetes',
      '/backoffice/dispositivos',
      '/backoffice/audit',
      '/backoffice/asociar',
    ]) {
      await page.goto(route);
      await expect(page.locator('.metrics-grid')).toBeVisible();

      const measured = await page.evaluate(() => {
        const grid = document.querySelector('.metrics-grid') as HTMLElement;
        const cards = [...grid.children].map((el) => el.getBoundingClientRect());
        const gaps = cards
          .slice(1)
          .map((card, index) => +(card.left - cards[index]!.right).toFixed(1));
        const labels = [...grid.querySelectorAll('.metric-card__label')].map((el) => {
          const cs = getComputedStyle(el);
          return {
            text: (el.textContent || '').trim().slice(0, 30),
            lines: Math.round(
              el.getBoundingClientRect().height / parseFloat(cs.lineHeight || '16'),
            ),
          };
        });
        const overflowing = [...grid.children]
          .filter((el) => el.scrollWidth > el.clientWidth + 1)
          .map((el) => (el.textContent || '').trim().slice(0, 30));
        return {
          count: cards.length,
          heights: cards.map((c) => +c.height.toFixed(1)),
          gaps,
          labels,
          overflowing,
          bars: grid.querySelectorAll('.metric-bar').length,
        };
      });

      expect(measured.count, `${route} must render four cards`).toBe(4);

      const tallest = Math.max(...measured.heights);
      const shortest = Math.min(...measured.heights);
      expect(
        tallest - shortest,
        `${route} card heights ${measured.heights.join(' / ')}`,
      ).toBeLessThanOrEqual(1);

      for (const gap of measured.gaps) {
        expect(Math.abs(gap - 8), `${route} gap ${gap}px`).toBeLessThanOrEqual(1);
      }

      for (const label of measured.labels) {
        expect(label.lines, `${route} label "${label.text}" wraps`).toBeLessThanOrEqual(2);
      }

      expect(measured.overflowing, `${route} cards overflow`).toEqual([]);
      expect(measured.bars, `${route} bars`).toBeGreaterThanOrEqual(3);
    }
  });

  test('the assignment cards name the two different counts', async ({ page }) => {
    await login(page);
    await page.goto('/backoffice/asociar');
    const grid = page.locator('.metrics-grid');

    // "Marbetes disponibles" (inventory) and "Disponibles" (matrículas) read
    // as the same thing; the cards now name each count explicitly.
    await expect(grid.getByText('Marbetes en inventario', { exact: true })).toBeVisible();
    await expect(grid.getByText('Matrículas sin marbete', { exact: true })).toBeVisible();
    await expect(grid.getByText('Marbetes disponibles', { exact: true })).toHaveCount(0);
  });

  test('the assignment screen contains its own scroll like the other table screens', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/backoffice/asociar');
    await expect(page.locator('.assignment-workspace')).toBeVisible();

    const measured = await page.evaluate(() => {
      const main = document.querySelector('main')!;
      const workspace = document.querySelector('.assignment-workspace')!.getBoundingClientRect();
      return {
        mainBottom: main.getBoundingClientRect().bottom,
        workspaceBottom: workspace.bottom,
        pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
        mainScrolls: main.scrollHeight > main.clientHeight + 2,
      };
    });

    expect(measured.pageScrolls, 'the document must not grow').toBe(false);
    expect(measured.mainScrolls, 'main must not grow with the workspace').toBe(false);
    expect(measured.workspaceBottom).toBeLessThanOrEqual(measured.mainBottom + 1);
  });

  test('the sidebar shows the INEC Conecta mark and the BackOffice title', async ({ page }) => {
    await login(page);
    const aside = page.locator('aside').first();

    await expect(aside.getByRole('img', { name: 'INEC Conecta' })).toBeVisible();
    // The standalone server only serves the file when `public/` was copied
    // into `.next/standalone/apps/web/public`; naturalWidth catches a 404 that
    // would otherwise pass on the alt text alone.
    expect(
      await aside
        .getByRole('img', { name: 'INEC Conecta' })
        .evaluate((img) => (img as HTMLImageElement).naturalWidth),
    ).toBeGreaterThan(0);
    await expect(aside.getByText('BackOffice', { exact: true })).toBeVisible();
    await expect(aside.getByText('QUORUM BACKOFFICE', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('sidebar-toggle')).toBeVisible();
  });

  test('the sidebar collapses, expands and remembers the choice', async ({ page }) => {
    await login(page);
    const aside = page.locator('aside').first();
    const toggle = page.getByTestId('sidebar-toggle');
    const asideWidth = () => aside.boundingBox().then((box) => box?.width ?? 0);

    const expanded = await asideWidth();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(expanded).toBeGreaterThanOrEqual(200); // 16rem = 256px track

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // The grid track is transitioned, so poll until it settles on the rail
    // (4.5rem = 72px) instead of sampling mid-flight.
    await expect.poll(asideWidth).toBeLessThanOrEqual(90);
    // The navigation stays reachable: the labels live in the accessibility tree
    // even when only the icon is painted. `exact` is required because the role
    // name filter is substring-based and "Marbetes" also matches
    // "Asignación de marbetes".
    await expect(aside.getByRole('link', { name: 'Marbetes', exact: true })).toBeVisible();

    await page.reload();
    await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(asideWidth).toBeLessThanOrEqual(90);

    await page.getByTestId('sidebar-toggle').click();
    await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(asideWidth).toBeGreaterThanOrEqual(200);
  });
});
