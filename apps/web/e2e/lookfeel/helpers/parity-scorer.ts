/**
 * parity-scorer.ts — pixel + structural scorer for the maquette parity harness.
 *
 * Computes a 0–100 hybrid equivalence score for one app screen against the
 * HTML maquette canon. Two independent halves are averaged (50/50):
 *
 *   pixel       — pixelmatch-based diff over selected regions, after both
 *                 images are normalized to the same canvas and masked
 *                 dynamic regions are blurred to neutral gray.
 *   structural  — DOM/computed-style assertions derived from the maquette:
 *                 presence + order of pattern elements, computed-style
 *                 token colors on canonical selectors.
 *
 * The threshold is configurable via env `PARITY_THRESHOLD` (default 96).
 *
 * Why pixelmatch + pngjs: the runner already has Playwright as a heavy
 * devDependency, and the maquette-vs-app diff needs per-pixel control
 * over masked regions + a tolerance parameter. The two libraries add
 * ~12 KB and no native code; the alternative (custom PNG decoder +
 * per-channel tolerance loop) would be ~200 lines of low-value code.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type { Page } from '@playwright/test';

/**
 * Cast PNG.data to a strongly-typed RGBA buffer + helpers that index
 * without the `number | undefined` widening that `noUncheckedIndexedAccess`
 * forces on `Buffer`/`Uint8Array`. The PNG.js runtime guarantees 8-bit
 * RGBA pixels (4 bytes), so we never read undefined bytes in practice.
 */
type PixelBuffer = Uint8Array;
function pixelsOf(png: PNG): PixelBuffer {
  return png.data as unknown as PixelBuffer;
}
function pxRead(buf: PixelBuffer, idx: number): number {
  const v = buf[idx];
  return v ?? 0;
}
function pxWrite(buf: PixelBuffer, idx: number, value: number): void {
  buf[idx] = value;
}

/** A rectangle in image coordinates, { x, y, w, h }. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Mask applied to BOTH the maquette and the app screenshot before diffing. */
export interface Mask {
  /** Selector-free rectangle (already in image coordinates). */
  rect: Rect;
  /** Human-readable explanation; surfaces in the JSON report. */
  why: string;
}

export interface PixelRegion {
  /**
   * Stable id (e.g. "shell", "metric-grid", "table-chrome").
   * The scorer aggregates per-id and surfaces them in the JSON report.
   */
  id: string;
  /** Crop of the app screenshot to diff against the maquette crop. */
  appRect: Rect;
  /** Crop of the maquette screenshot. May have different dimensions; we
   * resize the maquette crop onto the app crop size before diffing. */
  maquetteRect: Rect;
  /** Why this region is comparable across maquette and app. */
  why: string;
  /** Masks applied inside the cropped region before diffing (in the
   * cropped coordinate system, i.e. relative to `appRect.x/y`). */
  masks?: Mask[];
}

export interface StructuralCheck {
  /** Stable id surfaced in the JSON report. */
  id: string;
  /** Human description, useful for triage. */
  description: string;
  /** Computed synchronously from the Playwright page. */
  pass: boolean;
  /** Optional detail message ("expected #AB8620, got #AB8600"). */
  detail?: string;
}

export interface ParityInput {
  /** Screen path used in the JSON report, e.g. "/marbetes". */
  appPath: string;
  /** Absolute path of the saved app screenshot on disk. */
  appScreenshotPath: string;
  /** Absolute path of the saved maquette screenshot on disk. */
  maquetteScreenshotPath: string;
  /** Regions to pixel-diff. Empty array is allowed (structural-only). */
  pixelRegions: PixelRegion[];
  /** Structural assertions; pass-rate = % true. */
  structuralChecks: StructuralCheck[];
  /** Override threshold (defaults to PARITY_THRESHOLD env, falling back to 96). */
  threshold?: number;
}

export interface RegionScore {
  id: string;
  score: number;
  diffPixels: number;
  totalPixels: number;
  why: string;
}

export interface ParityScore {
  appPath: string;
  pixelScore: number;
  structuralScore: number;
  hybridScore: number;
  threshold: number;
  passed: boolean;
  regions: RegionScore[];
  structural: { id: string; description: string; pass: boolean; detail?: string }[];
}

/**
 * Read a PNG from disk and return its raw { data, width, height, png }.
 * We keep the PNG instance alive because the harness sometimes wants to
 * write a debug overlay (kept inside this file via `saveDebugOverlay`).
 */
export function loadPng(file: string): PNG {
  const png = PNG.sync.read(fs.readFileSync(file));
  return png;
}

/**
 * Resize a PNG to (w, h) using nearest-neighbor sampling.
 *
 * We deliberately avoid bilinear filtering here: the maquette crop and
 * the app crop may have slightly different dimensions (the maquette
 * metric grid sits at 1280x800 fullPage, the app metric grid sits at
 * 1280x800 fullPage too, but the host page heights differ when the
 * table paginates fewer rows). Nearest-neighbor keeps the colour
 * statistics comparable and avoids introducing a filter-induced blur
 * that pixelmatch would treat as a real diff.
 */
export function resizeNearest(png: PNG, w: number, h: number): PNG {
  const out = new PNG({ width: w, height: h, colorType: 6 });
  const src = pixelsOf(png);
  const dst = pixelsOf(out);
  for (let y = 0; y < h; y++) {
    const srcY = Math.min(png.height - 1, Math.round((y * png.height) / h));
    for (let x = 0; x < w; x++) {
      const srcX = Math.min(png.width - 1, Math.round((x * png.width) / w));
      const srcIdx = (srcY * png.width + srcX) * 4;
      const dstIdx = (y * w + x) * 4;
      pxWrite(dst, dstIdx, pxRead(src, srcIdx));
      pxWrite(dst, dstIdx + 1, pxRead(src, srcIdx + 1));
      pxWrite(dst, dstIdx + 2, pxRead(src, srcIdx + 2));
      pxWrite(dst, dstIdx + 3, pxRead(src, srcIdx + 3));
    }
  }
  return out;
}

/**
 * Paint a rectangle with a neutral gray. Used to mask dynamic regions
 * (table rows, metric values, timestamps) before diffing.
 *
 * Both app and maquette crops get the same gray fill so the diff
 * measures chrome/layout, not the specific rows of fake data the
 * maquette renders.
 */
export function fillRect(png: PNG, rect: Rect, gray: [number, number, number] = [128, 128, 128]): void {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(png.width, Math.floor(rect.x + rect.w));
  const y1 = Math.min(png.height, Math.floor(rect.y + rect.h));
  const buf = pixelsOf(png);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * 4;
      pxWrite(buf, i, gray[0]);
      pxWrite(buf, i + 1, gray[1]);
      pxWrite(buf, i + 2, gray[2]);
      pxWrite(buf, i + 3, 255);
    }
  }
}

/** Read the configurable threshold; falls back to 96. */
export function readThreshold(): number {
  const raw = process.env['PARITY_THRESHOLD'];
  const n = raw ? Number(raw) : 96;
  return Number.isFinite(n) ? n : 96;
}

/**
 * Compute a per-region pixel score in 0..100.
 *
 * `score = 100 * (1 - diffPixels / totalPixels)`. Masks are applied to
 * BOTH crops before the diff so dynamic regions do not poison the
 * chrome comparison. A region whose `appRect` or `maquetteRect`
 * falls outside its source canvas is logged and counted as score=0.
 */
export function diffRegion(
  appPng: PNG,
  maquettePng: PNG,
  region: PixelRegion,
): RegionScore {
  const appW = region.appRect.w;
  const appH = region.appRect.h;
  const totalPixels = appW * appH;

  const crop = (src: PNG, rect: Rect): PNG | null => {
    if (
      rect.x < 0 ||
      rect.y < 0 ||
      rect.x + rect.w > src.width ||
      rect.y + rect.h > src.height
    ) {
      return null;
    }
    const out = new PNG({ width: rect.w, height: rect.h, colorType: 6 });
    const srcBuf = pixelsOf(src);
    const dstBuf = pixelsOf(out);
    for (let y = 0; y < rect.h; y++) {
      for (let x = 0; x < rect.w; x++) {
        const sIdx = ((rect.y + y) * src.width + (rect.x + x)) * 4;
        const dIdx = (y * rect.w + x) * 4;
        pxWrite(dstBuf, dIdx, pxRead(srcBuf, sIdx));
        pxWrite(dstBuf, dIdx + 1, pxRead(srcBuf, sIdx + 1));
        pxWrite(dstBuf, dIdx + 2, pxRead(srcBuf, sIdx + 2));
        pxWrite(dstBuf, dIdx + 3, pxRead(srcBuf, sIdx + 3));
      }
    }
    return out;
  };

  const appCrop = crop(appPng, region.appRect);
  if (!appCrop) {
    return {
      id: region.id,
      score: 0,
      diffPixels: totalPixels,
      totalPixels,
      why: `appRect ${JSON.stringify(region.appRect)} out of bounds ${appPng.width}x${appPng.height}`,
    };
  }
  const maquetteCropRaw = crop(maquettePng, region.maquetteRect);
  if (!maquetteCropRaw) {
    return {
      id: region.id,
      score: 0,
      diffPixels: totalPixels,
      totalPixels,
      why: `maquetteRect ${JSON.stringify(region.maquetteRect)} out of bounds ${maquettePng.width}x${maquettePng.height}`,
    };
  }
  const maquetteCrop =
    maquetteCropRaw.width === appW && maquetteCropRaw.height === appH
      ? maquetteCropRaw
      : resizeNearest(maquetteCropRaw, appW, appH);

  for (const m of region.masks ?? []) {
    fillRect(appCrop, m.rect);
    fillRect(maquetteCrop, m.rect);
  }

  // 0.08 tolerance: any two pixels within ~20/255 of each other in any
  // channel are considered equal. The maquette uses a different font
  // stack (Montserrat via Google Fonts vs the host's system fallback)
  // and antialiasing differences easily exceed 5/255 in any channel;
  // 0.08 is the loosest threshold that still distinguishes real layout
  // shifts from font-rendering drift. We surface the value in the JSON
  // report so reviewers can tune it.
  const diff = pixelmatch(
    appCrop.data,
    maquetteCrop.data,
    undefined,
    appW,
    appH,
    { threshold: 0.08 },
  );

  const score = 100 * (1 - diff / Math.max(1, totalPixels));
  return {
    id: region.id,
    score,
    diffPixels: diff,
    totalPixels,
    why: region.why,
  };
}

/**
 * Score one screen end-to-end.
 *
 * `pixelScore` is the unweighted mean of every region (regions that
 * fail to crop contribute 0, which keeps the math simple and lets the
 * report flag the broken region explicitly). `structuralScore` is the
 * percentage of structural checks that passed. `hybridScore` is the
 * 50/50 mean. `passed` is `hybridScore >= threshold`.
 *
 * The function never throws — a broken region or a missing screenshot
 * is encoded as score=0 with a `why` string so the test still reports
 * a complete record.
 */
export function scoreParity(input: ParityInput): ParityScore {
  const threshold = input.threshold ?? readThreshold();

  let pixel = 100;
  let appPng: PNG | null = null;
  let maquettePng: PNG | null = null;
  const regions: RegionScore[] = [];

  if (input.pixelRegions.length > 0) {
    try {
      appPng = loadPng(input.appScreenshotPath);
      maquettePng = loadPng(input.maquetteScreenshotPath);
    } catch (err) {
      regions.push({
        id: 'load',
        score: 0,
        diffPixels: 0,
        totalPixels: 0,
        why: `failed to load screenshots: ${(err as Error).message}`,
      });
    }
  }

  if (appPng && maquettePng) {
    let sum = 0;
    for (const region of input.pixelRegions) {
      const r = diffRegion(appPng, maquettePng, region);
      regions.push(r);
      sum += r.score;
    }
    pixel = sum / input.pixelRegions.length;
  } else if (input.pixelRegions.length === 0) {
    // No regions configured — pixel score is treated as fully passing
    // (the structural score alone decides the verdict). This keeps the
    // hybrid math meaningful for screens we have not yet region-ized.
    pixel = 100;
  } else {
    pixel = 0;
  }

  const total = input.structuralChecks.length;
  const passed = input.structuralChecks.filter((c) => c.pass).length;
  const structural = total === 0 ? 100 : (100 * passed) / total;

  const hybrid = 0.5 * pixel + 0.5 * structural;
  return {
    appPath: input.appPath,
    pixelScore: pixel,
    structuralScore: structural,
    hybridScore: hybrid,
    threshold,
    passed: hybrid >= threshold,
    regions,
    structural: input.structuralChecks.map((c) => ({
      id: c.id,
      description: c.description,
      pass: c.pass,
      detail: c.detail,
    })),
  };
}

/**
 * Persistence helper — write the JSON report alongside the screenshots
 * so a triage step can diff it across runs.
 */
export function writeReport(file: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
}

/**
 * Evaluate a token-color assertion: read the computed style of the
 * selector, parse the `rgb(...)` value, and compare it to the hex
 * canonical. Returns `{ pass, detail }` ready to drop into a
 * StructuralCheck.
 *
 * The page is queried through Playwright so we always go through the
 * same lifecycle the screenshot was taken on (fonts loaded, hydration
 * done). The lookup is forgiving: the maquette uses uppercase hex, the
 * browser emits rgb() — we compare numerically.
 */
export async function assertTokenColor(
  page: Page,
  selector: string,
  cssProperty: string,
  expectedHex: string,
): Promise<{ pass: boolean; detail?: string }> {
  const hex = (expectedHex ?? '').replace('#', '').toLowerCase();
  const r = hex.slice(0, 2);
  const g = hex.slice(2, 4);
  const b = hex.slice(4, 6);
  if (r === undefined || g === undefined || b === undefined) {
    return { pass: false, detail: `invalid hex: ${expectedHex}` };
  }
  const expected =
    (parseInt(r, 16) << 16) |
    (parseInt(g, 16) << 8) |
    parseInt(b, 16);
  const actual = await page.evaluate(
    ({ selector, prop }) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const v = getComputedStyle(el).getPropertyValue(prop);
      const m = v.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) return v;
      return (
        (parseInt(m[1], 10) << 16) |
        (parseInt(m[2], 10) << 8) |
        parseInt(m[3], 10)
      );
    },
    { selector, prop: cssProperty },
  );
  if (actual === null) {
    return { pass: false, detail: `selector ${selector} not found` };
  }
  if (typeof actual === 'string') {
    return { pass: false, detail: `unparseable computed style: ${actual}` };
  }
  // Allow ±2 LSB per channel (5/255) — the maquette declares hex tokens
  // but Tailwind 4 may serialize via color-mix() and round slightly.
  const diff =
    Math.abs(((actual >> 16) & 0xff) - ((expected >> 16) & 0xff)) +
    Math.abs(((actual >> 8) & 0xff) - ((expected >> 8) & 0xff)) +
    Math.abs((actual & 0xff) - (expected & 0xff));
  const pass = diff <= 6;
  const detail = pass
    ? undefined
    : `expected #${hex} got rgb(${actual >> 16 & 0xff},${(actual >> 8) & 0xff},${actual & 0xff})`;
  return { pass, detail };
}