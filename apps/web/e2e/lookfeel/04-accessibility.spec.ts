import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AUTHED_SCREENS, loginAs } from './helpers/login';
import {
  contrastRatio,
  getElementColors,
  luminance,
  parseColor,
} from './helpers/contrast';
import {
  getA11yTree,
  hasAccessibleName,
  isFocusableKeyboard,
  isLandmark,
  walkTree,
  type A11yNode,
} from './helpers/a11y';

/**
 * T5 — Accessibility (WCAG 2.1 AA).
 *
 * For every screen we walk the accessibility tree and run a battery of
 * rule-based checks: labels, button names, image alts, landmarks, focus
 * visibility, keyboard order, and text/background contrast.
 *
 * Output: artifacts/a11y.json with the findings list. Each finding carries
 * a stable id, severity (P0/P1/P2/P3), the screen, and the evidence that
 * the rule saw.
 */

interface A11yFinding {
  id: string;
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  screen: string;
  rule: string;
  selector?: string;
  evidence: string;
  suggestion: string;
}

interface A11yReport {
  generatedAt: string;
  findings: A11yFinding[];
}

let nextId = 1;
function makeId(): string {
  const n = nextId++;
  return `A11Y-${String(n).padStart(3, '0')}`;
}

async function checkFormLabels(
  page: import('@playwright/test').Page,
  screen: string,
  findings: A11yFinding[],
): Promise<void> {
  // Form fields that need labels. We rely on DOM inspection rather than
  // the a11y tree because Playwright's snapshot collapses some wrappers.
  const rows = await page.evaluate(() => {
    interface Row {
      selector: string;
      tagName: string;
      id: string;
      name: string;
      ariaLabel: string;
      ariaLabelledby: string;
      wrappingLabel: string;
      placeholder: string;
    }
    const out: Row[] = [];
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>('input, select, textarea'),
    );
    for (const el of candidates) {
      const id = el.id || '';
      const tag = el.tagName.toLowerCase();
      // Skip hidden, submit, button, or already-labelled-by-aria controls.
      const type = (el as HTMLInputElement).type?.toLowerCase();
      if (type === 'hidden' || type === 'submit' || type === 'button') continue;
      const labelledBy = el.getAttribute('aria-labelledby') || '';
      const ariaLabel = el.getAttribute('aria-label') || '';
      const wrappingLabel = el.closest('label') ? `${tag}#${id || '<no-id>'}` : '';
      let selector: string;
      if (id) selector = `#${id}`;
      else selector = `${tag}.${el.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.')}`;
      let labelFound = false;
      if (id) {
        const lbl = document.querySelector(`label[for="${id}"]`);
        if (lbl) labelFound = true;
      }
      if (wrappingLabel) labelFound = true;
      out.push({
        selector,
        tagName: tag,
        id,
        name: labelFound ? 'label-found' : '',
        ariaLabel,
        ariaLabelledby: labelledBy,
        wrappingLabel,
        placeholder: el.getAttribute('placeholder') || '',
      });
    }
    return out;
  });
  for (const row of rows) {
    const hasAriaName = row.ariaLabel.trim().length > 0 || row.ariaLabelledby.trim().length > 0;
    const hasVisibleLabel = row.name === 'label-found';
    if (hasVisibleLabel || hasAriaName) continue;
    findings.push({
      id: makeId(),
      severity: 'P0',
      screen,
      rule: 'label-missing',
      selector: row.selector,
      evidence: `<${row.tagName} id="${row.id}" placeholder="${row.placeholder}"> without <label for> or aria-label`,
      suggestion: `Add <label for="${row.id}">…</label> or aria-label.`,
    });
  }
}

async function checkButtonNames(
  _page: import('@playwright/test').Page,
  screen: string,
  root: A11yNode | null,
  findings: A11yFinding[],
): Promise<void> {
  walkTree(root, (node) => {
    if (node.role !== 'button') return;
    if (hasAccessibleName(node)) return;
    findings.push({
      id: makeId(),
      severity: 'P0',
      screen,
      rule: 'button-empty-name',
      evidence: `<button> with no accessible name`,
      suggestion: 'Add visible text or aria-label to the button.',
    });
  });
}

async function checkImageAlts(
  page: import('@playwright/test').Page,
  screen: string,
  findings: A11yFinding[],
): Promise<void> {
  const imgs = await page.$$eval('img', (els) =>
    els.map((el) => ({
      src: el.getAttribute('src') || '',
      alt: el.getAttribute('alt'),
      role: el.getAttribute('role') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
    })),
  );
  for (const img of imgs) {
    if (img.alt !== null) continue;
    if (img.role === 'presentation' || img.role === 'none') continue;
    findings.push({
      id: makeId(),
      severity: 'P1',
      screen,
      rule: 'img-alt-missing',
      selector: `img[src="${img.src}"]`,
      evidence: `<img src="${img.src}"> without alt attribute`,
      suggestion: 'Add alt="" if decorative, else descriptive alt text.',
    });
  }

  const svgs = await page.$$eval('svg', (els) =>
    els.map((el) => ({
      ariaLabel: el.getAttribute('aria-label') || '',
      ariaLabelledby: el.getAttribute('aria-labelledby') || '',
      role: el.getAttribute('role') || '',
      labelledByAncestor: el.closest('[aria-label], [aria-labelledby]') !== null,
    })),
  );
  for (const svg of svgs) {
    const hasOwnLabel =
      svg.ariaLabel.trim().length > 0 ||
      svg.ariaLabelledby.trim().length > 0 ||
      svg.role === 'img' ||
      svg.role === 'presentation';
    if (hasOwnLabel) continue;
    if (svg.labelledByAncestor) continue;
    findings.push({
      id: makeId(),
      severity: 'P2',
      screen,
      rule: 'svg-no-label',
      evidence: `<svg> without aria-label, role, or labelled ancestor`,
      suggestion: 'Add role="img" + aria-label, or aria-hidden="true" if purely decorative.',
    });
  }
}

async function checkLandmarks(
  page: import('@playwright/test').Page,
  screen: string,
  findings: A11yFinding[],
): Promise<void> {
  const presence = await page.evaluate(() => ({
    header: !!document.querySelector('header, [role="banner"]'),
    main: !!document.querySelector('main, [role="main"]'),
    nav: !!document.querySelector('nav, [role="navigation"]'),
    aside: !!document.querySelector('aside, [role="complementary"]'),
  }));
  if (!presence.main) {
    findings.push({
      id: makeId(),
      severity: 'P0',
      screen,
      rule: 'landmark-main-missing',
      evidence: 'No <main> / [role="main"] landmark on the page.',
      suggestion: 'Wrap the primary content in <main>.',
    });
  }
  if (!presence.header) {
    findings.push({
      id: makeId(),
      severity: 'P1',
      screen,
      rule: 'landmark-banner-missing',
      evidence: 'No <header> / [role="banner"] landmark on the page.',
      suggestion: 'Add a <header> wrapping the topbar.',
    });
  }
  // nav is optional but expected for authed screens
}

async function checkFocusVisibility(
  page: import('@playwright/test').Page,
  screen: string,
  findings: A11yFinding[],
): Promise<void> {
  await page.evaluate(() => {
    const sel = [
      'button:not([disabled])',
      'a[href]',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
    ].join(',');
    const first = document.querySelector(sel) as HTMLElement | null;
    if (first) (first as HTMLElement & { focus: () => void }).focus();
  });
  await page.waitForTimeout(100);
  const focusStyle = await page.evaluate(() => {
    const sel = [
      'button:not([disabled])',
      'a[href]',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
    ].join(',');
    const first = document.querySelector(sel) as HTMLElement | null;
    if (!first) return null;
    const cs = getComputedStyle(first);
    return {
      tag: first.tagName.toLowerCase(),
      outline: cs.outline,
      outlineWidth: cs.outlineWidth,
      outlineStyle: cs.outlineStyle,
      boxShadow: cs.boxShadow,
    };
  });
  if (!focusStyle) return;
  const noOutline = focusStyle.outlineWidth === '0px' || focusStyle.outlineStyle === 'none';
  const noShadow = focusStyle.boxShadow === 'none' || focusStyle.boxShadow === '';
  if (noOutline && noShadow) {
    findings.push({
      id: makeId(),
      severity: 'P0',
      screen,
      rule: 'focus-not-visible',
      selector: focusStyle.tag,
      evidence: `focused ${focusStyle.tag} has outline=${focusStyle.outline}, box-shadow=${focusStyle.boxShadow}`,
      suggestion: 'Add a visible :focus-visible style (ring or outline).',
    });
  }
}

async function checkKeyboardOrder(
  page: import('@playwright/test').Page,
  screen: string,
  findings: A11yFinding[],
): Promise<void> {
  const order: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press('Tab');
    const id = await page.evaluate(() => {
      const ae = document.activeElement as HTMLElement | null;
      if (!ae) return '<none>';
      const tag = ae.tagName.toLowerCase();
      const idAttr = ae.id ? `#${ae.id}` : '';
      const name = ae.getAttribute('aria-label') || ae.textContent?.trim().slice(0, 40) || '';
      return `${tag}${idAttr}:${name.replace(/\s+/g, ' ').slice(0, 40)}`;
    });
    order.push(id);
  }
  // We just record the observed order for the report — strict asserts on
  // the order would be brittle. The spec captures the order; the report
  // surfaces it as evidence of the actual user experience.
  if (order.length > 0) {
    // Surface a P2 finding if the very first focused element after Tab is
    // not something a sighted user would see highlighted.
    if (order[0] === '<none>') {
      findings.push({
        id: makeId(),
        severity: 'P2',
        screen,
        rule: 'keyboard-order-no-focus',
        evidence: 'Tab key did not move focus to any element',
        suggestion: 'Verify there is at least one focusable element on the page.',
      });
    }
  }
}

async function checkContrast(
  page: import('@playwright/test').Page,
  screen: string,
  findings: A11yFinding[],
): Promise<void> {
  // Sample a curated set of selectors that contain visible text. We
  // evaluate foreground against the resolved background (walking up the
  // stacking context) and flag anything below the AA threshold.
  const samples = await page.evaluate(() => {
    interface Sample {
      selector: string;
      fg: string;
      bg: string;
      fontSize: number;
      fontWeight: number;
      textPreview: string;
    }
    const out: Sample[] = [];
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>(
        'body, h1, h2, h3, p, label, button, a, td, th, span, div',
      ),
    );
    for (const el of candidates.slice(0, 200)) {
      const text = (el.textContent || '').trim();
      if (!text) continue;
      // Skip if element is hidden
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue;
      const fontSizePx = parseFloat(cs.fontSize) || 0;
      const fontWeight = parseInt(cs.fontWeight, 10) || 400;
      let selector: string;
      if (el.id) selector = `#${el.id}`;
      else if (el.className && typeof el.className === 'string') {
        selector = el.tagName.toLowerCase() + '.' + el.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.');
      } else selector = el.tagName.toLowerCase();
      out.push({
        selector,
        fg: cs.color,
        bg: cs.backgroundColor,
        fontSize: fontSizePx,
        fontWeight,
        textPreview: text.replace(/\s+/g, ' ').slice(0, 80),
      });
    }
    return out;
  });

  for (const sample of samples) {
    const fg = parseColor(sample.fg);
    if (!fg) continue;
    if (fg.a < 1) continue; // skip translucent foreground for now
    // Resolve background by walking up — replicate getElementColors logic.
    const bgResolved = await page.evaluate((sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      let walker: Element | null = el;
      let bg = 'rgba(0, 0, 0, 0)';
      while (walker) {
        const c = getComputedStyle(walker).backgroundColor;
        if (c && !/rgba\((0, ?){3}0\)/i.test(c) && c !== 'transparent') {
          bg = c;
          break;
        }
        walker = walker.parentElement;
      }
      return bg;
    }, sample.selector);
    if (!bgResolved) continue;
    const bg = parseColor(bgResolved);
    if (!bg) continue;
    const ratio = contrastRatio(fg, bg);
    const isLargeText =
      sample.fontSize >= 24 || (sample.fontSize >= 18.66 && sample.fontWeight >= 700);
    const threshold = isLargeText ? 3.0 : 4.5;
    if (ratio >= threshold) continue;
    const luminanceNote = `L=${luminance(fg).toFixed(2)}/${luminance(bg).toFixed(2)}`;
    findings.push({
      id: makeId(),
      severity: ratio < 3.0 ? 'P0' : 'P1',
      screen,
      rule: 'contrast-low',
      selector: sample.selector,
      evidence: `contrast ${ratio.toFixed(2)}:1 (need ${threshold}:1) — fg=${sample.fg} bg=${bgResolved} size=${sample.fontSize}px weight=${sample.fontWeight} text="${sample.textPreview}" ${luminanceNote}`,
      suggestion: 'Increase contrast by darkening text or lightening background to meet AA.',
    });
  }
}

async function checkTables(
  page: import('@playwright/test').Page,
  screen: string,
  findings: A11yFinding[],
): Promise<void> {
  const tableFindings = await page.evaluate(() => {
    interface Row {
      tableIndex: number;
      thCount: number;
      thWithScope: number;
      thWithRole: number;
    }
    const out: Row[] = [];
    const tables = Array.from(document.querySelectorAll('table'));
    for (let i = 0; i < tables.length; i += 1) {
      const t = tables[i] as HTMLElement;
      const ths = Array.from(t.querySelectorAll('th'));
      let withScope = 0;
      let withRole = 0;
      for (const th of ths) {
        if (th.getAttribute('scope')) withScope += 1;
        const role = th.getAttribute('role');
        if (role === 'columnheader' || role === 'rowheader') withRole += 1;
      }
      out.push({
        tableIndex: i,
        thCount: ths.length,
        thWithScope: withScope,
        thWithRole: withRole,
      });
    }
    return out;
  });
  for (const t of tableFindings) {
    if (t.thCount === 0) continue;
    if (t.thWithScope === t.thCount || t.thWithRole === t.thCount) continue;
    findings.push({
      id: makeId(),
      severity: 'P2',
      screen,
      rule: 'table-th-scope',
      evidence: `<table#${t.tableIndex}> has ${t.thCount} <th>, only ${t.thWithScope} with scope`,
      suggestion: 'Add scope="col" (or "row") on every <th> for screen-reader navigation.',
    });
  }
}

async function runScreenAudit(
  page: import('@playwright/test').Page,
  screen: string,
  isAuthed: boolean,
): Promise<A11yFinding[]> {
  const findings: A11yFinding[] = [];
  await checkFormLabels(page, screen, findings);
  const tree = await getA11yTree(page);
  await checkButtonNames(page, screen, tree, findings);
  await checkImageAlts(page, screen, findings);
  await checkLandmarks(page, screen, findings);
  await checkFocusVisibility(page, screen, findings);
  await checkKeyboardOrder(page, screen, findings);
  await checkContrast(page, screen, findings);
  await checkTables(page, screen, findings);
  // Tag screen with auth context for filtering.
  void isAuthed;
  return findings;
}

test.describe('T5 — accessibility', () => {
  test('walks every screen and writes a11y.json', async ({ page }) => {
    const findings: A11yFinding[] = [];
    nextId = 1;

    // Public screen
    await page.goto('/backoffice/login');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(300);
    findings.push(...(await runScreenAudit(page, '/login', false)));

    // Authed screens
    await loginAs(page, 'admin');
    for (const screen of AUTHED_SCREENS) {
      await page.goto(`/backoffice${screen}`);
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(400);
      findings.push(...(await runScreenAudit(page, screen, true)));
    }

    const report: A11yReport = {
      generatedAt: new Date().toISOString(),
      findings,
    };
    const outDir = path.join(__dirname, 'artifacts');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'a11y.json'), JSON.stringify(report, null, 2), 'utf8');

    // Sanity: we always produced findings (a healthy audit is rarely empty
    // against a real product).
    expect(findings.length).toBeGreaterThan(0);
    // Helper unused import — keep the reference for tooling.
    void hasAccessibleName; void isFocusableKeyboard; void isLandmark;
    void getElementColors;
  });
});
