import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ALL_VIEWPORTS, viewportSlug } from './helpers/viewports';
import { AUTHED_SCREENS, loginAs, type Role } from './helpers/login';
import { captureSnapshot } from './helpers/snapshot';

/**
 * T4 — Responsive audit.
 *
 * Iterates every viewport × (role × screen) combination. Captures a
 * full-page screenshot, then measures:
 *   - horizontal overflow at the document root
 *   - sidebar visibility/state
 *   - overflowing direct children of <main>
 *
 * Output: artifacts/responsive.json with one row per (viewport, role, screen).
 */

interface OverflowFinding {
  viewport: string;
  role: Role;
  screen: string;
  scrollWidth: number;
  clientWidth: number;
  horizontalOverflow: boolean;
  overflowingChildren: Array<{ selector: string; width: number; parentWidth: number }>;
}

interface SidebarState {
  display: string;
  width: number;
}

interface ResponsiveRow {
  viewport: string;
  role: Role;
  screen: string;
  scrollWidth: number;
  clientWidth: number;
  horizontalOverflow: boolean;
  sidebar: SidebarState | null;
  overflowingChildrenCount: number;
}

interface ResponsiveReport {
  generatedAt: string;
  rows: ResponsiveRow[];
  findings: OverflowFinding[];
}

test.describe('T4 — responsive', () => {
  test('captures per-viewport baseline and overflow report', async ({ browser }) => {
    const rows: ResponsiveRow[] = [];
    const findings: OverflowFinding[] = [];
    const ROLES: Role[] = ['admin', 'auditor', 'operator'];

    for (const vp of ALL_VIEWPORTS) {
      for (const role of ROLES) {
        const context = await browser.newContext({
          viewport: vp.viewport,
          deviceScaleFactor: 1,
        });
        const page = await context.newPage();
        await loginAs(page, role);

        for (const screen of AUTHED_SCREENS) {
          await page.goto(`/backoffice${screen}`);
          await page.waitForLoadState('domcontentloaded');
          await page.waitForTimeout(400);
          const slug = viewportSlug(vp.name);
          await captureSnapshot(page, {
            name: screen,
            role,
            viewport: slug,
          });

          const measurements = await page.evaluate(() => {
            const overflowingChildren: Array<{ selector: string; width: number; parentWidth: number }> = [];
            const main = document.querySelector('main');
            if (main) {
              for (const child of Array.from(main.children)) {
                const childEl = child as HTMLElement;
                const childWidth = childEl.offsetWidth;
                const parentWidth = main.clientWidth;
                if (childWidth > parentWidth + 1) {
                  let sel = childEl.tagName.toLowerCase();
                  if (childEl.id) sel = `#${childEl.id}`;
                  else if (childEl.className && typeof childEl.className === 'string') {
                    sel += '.' + childEl.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.');
                  }
                  overflowingChildren.push({ selector: sel, width: childWidth, parentWidth });
                }
              }
            }
            const sidebar = document.querySelector('aside') as HTMLElement | null;
            const sidebarState = sidebar
              ? {
                  display: getComputedStyle(sidebar).display,
                  width: sidebar.getBoundingClientRect().width,
                }
              : null;
            return {
              scrollWidth: document.documentElement.scrollWidth,
              clientWidth: document.documentElement.clientWidth,
              overflowingChildren,
              sidebarState,
            };
          });

          const row: ResponsiveRow = {
            viewport: vp.name,
            role,
            screen,
            scrollWidth: measurements.scrollWidth,
            clientWidth: measurements.clientWidth,
            horizontalOverflow: measurements.scrollWidth > measurements.clientWidth + 1,
            sidebar: measurements.sidebarState,
            overflowingChildrenCount: measurements.overflowingChildren.length,
          };
          rows.push(row);

          if (row.horizontalOverflow || measurements.overflowingChildren.length > 0) {
            findings.push({
              viewport: vp.name,
              role,
              screen,
              scrollWidth: measurements.scrollWidth,
              clientWidth: measurements.clientWidth,
              horizontalOverflow: row.horizontalOverflow,
              overflowingChildren: measurements.overflowingChildren,
            });
          }
        }
        await context.close();
      }
    }

    const outDir = path.join(__dirname, 'artifacts');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'responsive.json'),
      JSON.stringify(
        { generatedAt: new Date().toISOString(), rows, findings } as ResponsiveReport,
        null,
        2,
      ),
      'utf8',
    );

    // Sanity: the matrix produced the expected number of rows.
    expect(rows.length).toBe(ALL_VIEWPORTS.length * 3 * AUTHED_SCREENS.length);
  });
});
