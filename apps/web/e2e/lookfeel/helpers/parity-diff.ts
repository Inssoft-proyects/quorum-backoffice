/**
 * parity-diff.ts — visualize the per-pixel differences between the
 * maquette baseline and the live app screenshot.
 *
 * Loads both PNGs, applies the dynamic + chrome masks computed by
 * the harness, then writes:
 *   - diff.png          : red pixels where app differs from baseline
 *   - side-by-side.png  : baseline | app | diff (top-to-bottom)
 *   - per-strip stats   : JSON listing which horizontal strips
 *                         concentrate the most diff pixels
 *
 * Used as a triage tool for the parity harness — not part of the
 * automated spec. Invoke directly via:
 *   tsx helpers/parity-diff.ts <baseline.png> <app.png> [outDir]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { resizeNearest } from './parity-scorer';

const DEFAULT_TOLERANCE = 0.08;

function loadPng(file: string): PNG {
  return PNG.sync.read(fs.readFileSync(file));
}

/**
 * Find the bounding box of the live app's chrome (sidebar + topbar)
 * by selecting the corresponding DOM elements. This is a best-effort
 * estimator used only for the triage script; the actual harness
 * masks use real Playwright boundingBox queries against the live
 * page.
 */
function chromeBoxEstimates(appPng: PNG): { sidebar?: { x: number; y: number; w: number; h: number }; topbar?: { x: number; y: number; w: number; h: number } } {
  // Heuristic: the app sidebar is ~256px wide on the left. The
  // topbar is ~56px tall on top. We only use these as defaults
  // when the caller doesn't override them.
  return {
    sidebar: { x: 0, y: 0, w: 256, h: appPng.height },
    topbar: { x: 0, y: 0, w: appPng.width, h: 56 },
  };
}

function fillRect(png: PNG, rect: { x: number; y: number; w: number; h: number }, gray: [number, number, number] = [128, 128, 128]): void {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(png.width, Math.floor(rect.x + rect.w));
  const y1 = Math.min(png.height, Math.floor(rect.y + rect.h));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * 4;
      png.data[i] = gray[0];
      png.data[i + 1] = gray[1];
      png.data[i + 2] = gray[2];
      png.data[i + 3] = 255;
    }
  }
}

interface DiffOptions {
  baseline: string;
  app: string;
  outDir: string;
  tolerance?: number;
  masks?: { x: number; y: number; w: number; h: number; why: string }[];
}

function diff(opts: DiffOptions): { score: number; diffPixels: number; totalPixels: number } {
  const baseline = loadPng(opts.baseline);
  const app = loadPng(opts.app);
  const w = Math.min(baseline.width, app.width);
  const h = Math.min(baseline.height, app.height);
  const baselineCrop = resizeNearest(baseline, w, h);
  const appCrop = resizeNearest(app, w, h);
  for (const m of opts.masks ?? []) {
    fillRect(baselineCrop, m);
    fillRect(appCrop, m);
  }
  const diffPng = new PNG({ width: w, height: h, colorType: 6 });
  const diffPixels = pixelmatch(
    baselineCrop.data,
    appCrop.data,
    diffPng.data,
    w,
    h,
    { threshold: opts.tolerance ?? DEFAULT_TOLERANCE },
  );
  fs.mkdirSync(opts.outDir, { recursive: true });
  fs.writeFileSync(path.join(opts.outDir, 'diff.png'), PNG.sync.write(diffPng));
  // Side-by-side image: baseline | app | diff. We stack horizontally
  // because the heights match after the resize-to-common step.
  const gap = 10;
  const composite = new PNG({ width: w * 3 + gap * 2, height: h, colorType: 6 });
  const baselineBuf = baselineCrop.data;
  const appBuf = appCrop.data;
  const diffBuf = diffPng.data;
  const compBuf = composite.data;
  const compW = composite.width;
  const setPx = (
    buf: Uint8Array,
    idx: number,
    value: number | undefined,
  ): void => {
    buf[idx] = value ?? 0;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sIdx = (y * w + x) * 4;
      const baseOff = (y * compW + x) * 4;
      setPx(compBuf, baseOff, baselineBuf[sIdx]);
      setPx(compBuf, baseOff + 1, baselineBuf[sIdx + 1]);
      setPx(compBuf, baseOff + 2, baselineBuf[sIdx + 2]);
      compBuf[baseOff + 3] = 255;

      const aOff = (y * compW + (w + gap + x)) * 4;
      setPx(compBuf, aOff, appBuf[sIdx]);
      setPx(compBuf, aOff + 1, appBuf[sIdx + 1]);
      setPx(compBuf, aOff + 2, appBuf[sIdx + 2]);
      compBuf[aOff + 3] = 255;

      const dOff = (y * compW + ((w + gap) * 2 + x)) * 4;
      setPx(compBuf, dOff, diffBuf[sIdx]);
      setPx(compBuf, dOff + 1, diffBuf[sIdx + 1]);
      setPx(compBuf, dOff + 2, diffBuf[sIdx + 2]);
      compBuf[dOff + 3] = 255;
    }
  }
  fs.writeFileSync(path.join(opts.outDir, 'side-by-side.png'), PNG.sync.write(composite));
  // Per-strip stats: 50px tall horizontal slices, top diff regions.
  const strip = 50;
  const counts = new Map<number, number>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (diffPng.data[i] === 255 && diffPng.data[i + 1] === 0 && diffPng.data[i + 2] === 0) {
        const band = Math.floor(y / strip) * strip;
        counts.set(band, (counts.get(band) ?? 0) + 1);
      }
    }
  }
  const stats = Array.from(counts.entries())
    .map(([y, count]) => ({ yStart: y, yEnd: y + strip, diffPixels: count }))
    .sort((a, b) => b.diffPixels - a.diffPixels);
  fs.writeFileSync(
    path.join(opts.outDir, 'strip-stats.json'),
    JSON.stringify({ width: w, height: h, stripHeight: strip, topStrips: stats.slice(0, 20) }, null, 2),
  );
  const totalPixels = w * h;
  const score = 100 * (1 - diffPixels / totalPixels);
  return { score, diffPixels, totalPixels };
}

const [, , baselineArg, appArg, outDirArg] = process.argv;
if (!baselineArg || !appArg) {
  console.error('usage: tsx parity-diff.ts <baseline.png> <app.png> [outDir]');
  process.exit(2);
}
const outDir = outDirArg ?? path.join(path.dirname(appArg), 'diff');
const appPng = loadPng(appArg);
const chrome = chromeBoxEstimates(appPng);
const masks = [chrome.sidebar, chrome.topbar]
  .filter((m): m is { x: number; y: number; w: number; h: number } => Boolean(m))
  .map((m) => ({ ...m, why: 'auto chrome' }));
const result = diff({ baseline: baselineArg, app: appArg, outDir, masks });
console.log(`wrote ${outDir}`);
console.log(`score: ${result.score.toFixed(2)}%`);
console.log(`diff: ${result.diffPixels} / ${result.totalPixels}`);
