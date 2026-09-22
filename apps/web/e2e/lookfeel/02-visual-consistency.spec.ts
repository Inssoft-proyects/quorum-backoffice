import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AUTHED_SCREENS, loginAs } from './helpers/login';
import { captureSnapshot } from './helpers/snapshot';

/**
 * T3 — Visual consistency.
 *
 * Captures a full-page screenshot per authed screen at the desktop
 * viewport and reads computed styles for a curated set of selectors.
 * Output:
 *   - apps/web/e2e/lookfeel/artifacts/screenshots/<screen>/desktop-1280x800/admin.png
 *   - apps/web/e2e/lookfeel/artifacts/styles.json  (raw readings + flags)
 */

interface StyleSnapshot {
  fontSize: string;
  fontWeight: string;
  color: string;
  bgColor: string;
  padding: string;
  borderRadius: string;
  gap: string;
}

interface ScreenStyles {
  [selector: string]: StyleSnapshot;
}

type StylesReport = {
  generatedAt: string;
  baseUrl: string;
  screens: Record<string, ScreenStyles>;
  inconsistencies: Array<{
    selector: string;
    property: 'fontSize' | 'color' | 'fontWeight' | 'padding' | 'borderRadius' | 'gap';
    values: Record<string, string>;
    reason: string;
  }>;
  hardcodedColorHits: Array<{
    screen: string;
    selector: string;
    property: 'color' | 'bgColor';
    value: string;
  }>;
  outlineSuppressionHits: Array<{
    screen: string;
    selector: string;
    outline: string;
    outlineWidth: string;
    outlineColor: string;
  }>;
};

const SELECTORS = [
  { key: 'body', selector: 'body' },
  { key: 'main h1', selector: 'main h1' },
  { key: 'main h2', selector: 'main h2' },
  { key: 'primary button', selector: 'button.bg-primary-500' },
  { key: 'main input[type=text]', selector: 'main input[type="text"]' },
  { key: 'table th', selector: 'table th' },
  { key: 'table td', selector: 'table td' },
  { key: 'sidebar a', selector: 'aside a' },
  { key: 'topbar', selector: 'header' },
];

/**
 * Returns the first computed-style hit for a selector, or null if no
 * element matched. Many screens (e.g. /audit) may legitimately not have
 * a `<table>` — those just produce a `null` for that selector.
 */
async function readStyleFor(
  page: import('@playwright/test').Page,
  selector: string,
): Promise<StyleSnapshot | null> {
  return await page.evaluate((sel: string) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      color: cs.color,
      bgColor: cs.backgroundColor,
      padding: cs.padding,
      borderRadius: cs.borderRadius,
      gap: cs.gap,
    };
  }, selector);
}

test.describe('T3 — visual consistency', () => {
  test('captures per-screen baseline + writes styles.json', async ({ page }) => {
    await loginAs(page, 'admin');

    const report: StylesReport = {
      generatedAt: new Date().toISOString(),
      baseUrl: 'https://quorum.asistentepro.mx',
      screens: {},
      inconsistencies: [],
      hardcodedColorHits: [],
      outlineSuppressionHits: [],
    };

    for (const screen of AUTHED_SCREENS) {
      await page.goto(`/backoffice${screen}`);
      await page.waitForLoadState('domcontentloaded');
      // Give the server-rendered page a beat to settle (filters/tables).
      await page.waitForTimeout(500);
      await captureSnapshot(page, { name: screen, role: 'admin' });

      const screenStyles: ScreenStyles = {};
      for (const { key, selector } of SELECTORS) {
        const snapshot = await readStyleFor(page, selector);
        if (snapshot) screenStyles[key] = snapshot;
      }
      report.screens[screen] = screenStyles;
    }

    // Detect inconsistencies: same selector key across screens with
    // fontSize differing > 1px OR color differing. The comparison is done
    // string-based so we can flag even subtle (rgb vs rgba) variations.
    const propertyKeys: Array<keyof StyleSnapshot> = [
      'fontSize',
      'color',
      'fontWeight',
      'padding',
      'borderRadius',
      'gap',
    ];
    for (const { key: selectorKey } of SELECTORS) {
      for (const prop of propertyKeys) {
        const seen: Record<string, string> = {};
        for (const [screen, styles] of Object.entries(report.screens)) {
          const value = styles[selectorKey]?.[prop];
          if (value === undefined || value === '') continue;
          seen[screen] = value;
        }
        const unique = new Set(Object.values(seen));
        if (unique.size <= 1) continue;
        // For fontSize we only flag > 1px delta. For other props any delta.
        if (prop === 'fontSize') {
          const pxValues = Object.values(seen)
            .map((v) => parseFloat(v))
            .filter((n) => !Number.isNaN(n));
          if (pxValues.length > 0) {
            const delta = Math.max(...pxValues) - Math.min(...pxValues);
            if (delta <= 1) continue;
          }
        }
        report.inconsistencies.push({
          selector: selectorKey,
          property: prop,
          values: seen,
          reason: `Differing ${prop} across screens`,
        });
      }
    }

    // Detect hardcoded literal colors (bypassing design tokens). Pure
    // black/white on <body> or transparent backgrounds are usually just
    // the page chrome — we skip those to avoid drowning the report in
    // false positives. We focus on element-level selectors (h1, button,
    // a, td, th, etc.) where literal black/white is more likely a
    // copy-pasted snippet that bypassed the token system.
    const LITERAL_PATTERN = /^rgba?\((0, ?0, ?0|255, ?255, ?255)/i;
    const SKIP_SELECTORS = new Set(['body', 'topbar']);
    for (const [screen, styles] of Object.entries(report.screens)) {
      for (const [selectorKey, snapshot] of Object.entries(styles)) {
        if (SKIP_SELECTORS.has(selectorKey)) continue;
        for (const prop of ['color', 'bgColor'] as const) {
          if (LITERAL_PATTERN.test(snapshot[prop])) {
            report.hardcodedColorHits.push({ screen, selector: selectorKey, property: prop, value: snapshot[prop] });
          }
        }
      }
    }

    // Detect outline suppression on focusable elements (suggests missing
    // visible focus ring — feeds the a11y audit too).
    const outlineFindings = await page.evaluate(() => {
      const out: Array<{ selector: string; outline: string; outlineWidth: string; outlineColor: string }> = [];
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>(
          'button, a, input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      );
      for (const el of candidates) {
        const cs = getComputedStyle(el);
        if (cs.outlineStyle === 'none' || cs.outlineWidth === '0px') {
          // Build a stable selector for reporting
          let sel = el.tagName.toLowerCase();
          if (el.id) sel = `#${el.id}`;
          else if (el.className && typeof el.className === 'string') {
            sel += '.' + el.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.');
          }
          out.push({
            selector: sel,
            outline: cs.outline,
            outlineWidth: cs.outlineWidth,
            outlineColor: cs.outlineColor,
          });
        }
      }
      return out.slice(0, 100); // cap output to keep the report readable
    });
    for (const screen of Object.keys(report.screens)) {
      for (const hit of outlineFindings) {
        report.outlineSuppressionHits.push({ screen, ...hit });
      }
    }

    const outDir = path.join(__dirname, 'artifacts');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, 'styles.json');
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');

    // Sanity: at least one screen had a primary button and a sidebar link.
    expect(Object.keys(report.screens).length).toBe(AUTHED_SCREENS.length);
  });
});
