/**
 * Centralized viewport definitions for the responsive audit (T4).
 *
 * The four viewports span the matrix the design was checked against:
 *   - mobile  (360×800)   — small Android
 *   - tablet  (768×1024)  — iPad portrait
 *   - desktop (1280×800)  — common laptop
 *   - wide    (1920×1080) — full-HD monitor
 */
export type ViewportSize = { width: number; height: number };

export const VIEWPORTS: Record<string, ViewportSize> = {
  mobile: { width: 360, height: 800 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 800 },
  wide: { width: 1920, height: 1080 },
};

export const ALL_VIEWPORTS: Array<{ name: string; viewport: ViewportSize }> = (
  Object.entries(VIEWPORTS) as Array<[string, ViewportSize]>
).map(([name, viewport]) => ({ name, viewport }));

/** Friendly label used in screenshot paths and report rows. */
export function viewportSlug(name: string): string {
  const v = VIEWPORTS[name];
  if (!v) return name;
  return `${name}-${v.width}x${v.height}`;
}
