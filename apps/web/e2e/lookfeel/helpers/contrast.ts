import type { Page } from '@playwright/test';

/**
 * Minimal CSS color → sRGB color math, enough to power the contrast-ratio
 * checks used by the accessibility audit (T5).
 *
 * We accept the formats browsers return from getComputedStyle:
 *   - "#rgb" / "#rrggbb"
 *   - "rgb(r, g, b)" / "rgba(r, g, b, a)"
 * and normalize them into {r, g, b, a} tuples in the 0..255 range.
 *
 * The relative-luminance formula and contrast-ratio formula are the ones
 * defined by WCAG 2.x:
 *   https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 *   https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
 */

export interface RGBColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED_COLORS: Record<string, [number, number, number]> = {
  transparent: [0, 0, 0],
  black: [0, 0, 0],
  white: [255, 255, 255],
  red: [255, 0, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
};

/**
 * Parses a CSS color string into {r, g, b, a}. Supports the formats that
 * `getComputedStyle` typically returns in Chromium. Returns null if the
 * input cannot be parsed — callers should treat that as a soft skip.
 */
export function parseColor(input: string | null | undefined): RGBColor | null {
  if (!input) return null;
  const value = input.trim().toLowerCase();
  if (!value) return null;

  // Named colors (small set — only those likely to appear in computed styles)
  if (NAMED_COLORS[value]) {
    const [r, g, b] = NAMED_COLORS[value];
    return { r, g, b, a: 1 };
  }

  // #rgb or #rrggbb
  if (value.startsWith('#')) {
    const hex = value.slice(1);
    if (hex.length === 3) {
      const r = parseInt((hex[0] ?? '') + (hex[0] ?? ''), 16);
      const g = parseInt((hex[1] ?? '') + (hex[1] ?? ''), 16);
      const b = parseInt((hex[2] ?? '') + (hex[2] ?? ''), 16);
      if ([r, g, b].some((n) => Number.isNaN(n))) return null;
      return { r, g, b, a: 1 };
    }
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      if ([r, g, b].some((n) => Number.isNaN(n))) return null;
      return { r, g, b, a: 1 };
    }
    if (hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = parseInt(hex.slice(6, 8), 16) / 255;
      if ([r, g, b].some((n) => Number.isNaN(n))) return null;
      return { r, g, b, a };
    }
    return null;
  }

  // rgb(...) / rgba(...)
  const rgbMatch = value.match(
    /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/,
  );
  if (rgbMatch) {
    const r = clampByte(parseChannel(rgbMatch[1] ?? '0'));
    const g = clampByte(parseChannel(rgbMatch[2] ?? '0'));
    const b = clampByte(parseChannel(rgbMatch[3] ?? '0'));
    const aRaw = rgbMatch[4];
    let a = 1;
    if (aRaw !== undefined) {
      a = aRaw.endsWith('%') ? parseFloat(aRaw) / 100 : parseFloat(aRaw);
      if (Number.isNaN(a)) a = 1;
    }
    return { r, g, b, a };
  }

  return null;
}

function parseChannel(raw: string): number {
  return parseFloat(raw);
}

function clampByte(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

/** Channel value in 0..1, gamma-expanded for the WCAG luminance formula. */
function channelLinear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** Relative luminance per WCAG 2.x. */
export function luminance(rgb: RGBColor): number {
  const r = channelLinear(rgb.r);
  const g = channelLinear(rgb.g);
  const b = channelLinear(rgb.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio per WCAG 2.x. Returns a value in [1, 21]. */
export function contrastRatio(a: RGBColor, b: RGBColor): number {
  const la = luminance(a);
  const lb = luminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Resolves the effective background for an element by walking up the
 * stacking context until we find a non-transparent background. This is
 * required because Tailwind/utility classes routinely leave the body
 * background at `transparent` and only paint the page on the `<html>`.
 *
 * Returns the raw CSS color strings; callers should pipe them through
 * `parseColor()` to get a typed RGBColor. Doing it here would force a
 * `page.evaluate` round-trip into the Node realm and that's not worth it
 * for a helper that's only used in tests.
 */
export async function getElementColors(
  page: Page,
  selector: string,
): Promise<{ fg: string | null; bg: string | null }> {
  return await page.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    if (!el) return { fg: null, bg: null };
    const fg = getComputedStyle(el).color;
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
    return { fg, bg };
  }, selector);
}

/**
 * Composite a foreground color over a background color using the standard
 * "source over" Porter-Duff operator. Useful when a node has a translucent
 * background layered over an opaque one (e.g. dialog overlay).
 */
export function compositeOver(fg: RGBColor, bg: RGBColor): RGBColor {
  const a = fg.a;
  return {
    r: Math.round(fg.r * a + bg.r * (1 - a)),
    g: Math.round(fg.g * a + bg.g * (1 - a)),
    b: Math.round(fg.b * a + bg.b * (1 - a)),
    a: 1,
  };
}
