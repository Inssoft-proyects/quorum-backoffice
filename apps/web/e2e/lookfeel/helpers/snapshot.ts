import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import type { Role } from './login';

/**
 * Screenshot helpers. All artifacts land under
 *   apps/web/e2e/lookfeel/artifacts/screenshots/<screen>/<viewport>/<role>[-<suffix>].png
 *
 * Parent directories are created lazily; the directory tree is also added
 * to the local `.gitignore` so we never commit binary evidence by accident.
 */

const ROOT = path.join(
  __dirname,
  '..',
  'artifacts',
  'screenshots',
);

export interface SnapshotOptions {
  /** Logical name of the screen, e.g. '/dashboard' or '/login'. */
  name: string;
  /** Role that was active when the screenshot was captured. */
  role: Role | 'anonymous';
  /** Viewport slug, e.g. 'desktop-1280x800' (defaults to 'desktop-1280x800'). */
  viewport?: string;
  /** Optional suffix to disambiguate snapshots on the same screen (e.g. 'dialog-open'). */
  suffix?: string;
  /** If true, capture full page; otherwise only the viewport. */
  fullPage?: boolean;
}

export interface SnapshotResult {
  path: string;
}

function safeSegment(s: string): string {
  return s.replace(/[^a-z0-9-_]/gi, '_').replace(/^_+|_+$/g, '');
}

/**
 * Captures a screenshot of the current page state.
 *
 * Builds the target path from the structured options and creates any
 * missing parent directories. Returns the absolute path so the caller can
 * reference it in the report.
 */
export async function captureSnapshot(
  page: Page,
  opts: SnapshotOptions,
): Promise<SnapshotResult> {
  const viewport = opts.viewport ?? 'desktop-1280x800';
  const screen = safeSegment(opts.name.replace(/^\//, '') || 'root');
  const role = safeSegment(opts.role);
  const suffix = opts.suffix ? `-${safeSegment(opts.suffix)}` : '';
  const filename = `${role}${suffix}.png`;
  const target = path.join(ROOT, screen, viewport, filename);

  fs.mkdirSync(path.dirname(target), { recursive: true });
  await page.screenshot({ path: target, fullPage: opts.fullPage ?? true });

  return { path: target };
}
