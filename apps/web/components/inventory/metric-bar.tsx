'use client';

import * as React from 'react';

export interface MetricBarSegment {
  /** Share in 0-100. Multiple segments should sum to ≈100; the track
   * itself accounts for the remainder. */
  percent: number;
  /** Any CSS color (token, hex, rgb). */
  color: string;
}

export interface MetricBarProps {
  /** Stacked segments. When omitted, `ratio` is used instead. */
  segments?: ReadonlyArray<MetricBarSegment>;
  /** Single-share fallback (0-100) used when no `segments` are given. */
  ratio?: number;
  /** Accessible label for the whole bar; required. */
  label: string;
  /** Extra className on the track element. */
  className?: string;
}

/**
 * Compact stacked proportional bar — inspired by the *Poll Results*
 * micro-interaction from interior.dev. The donut was retired because
 * it forced every metric card to reserve ~195 px of vertical space and
 * the centre label ended up overlapping the value text on narrow
 * viewports. The bar sits on the same row as the meta line, animates
 * its segment widths, and honours `prefers-reduced-motion`.
 *
 * Presentational only — `metric-card.tsx` owns the surrounding layout.
 */
export function MetricBar({
  segments,
  ratio,
  label,
  className,
}: MetricBarProps): React.ReactElement {
  const hasSegments = Array.isArray(segments) && segments.length > 0;
  const ratioNum = typeof ratio === 'number' ? Math.max(0, Math.min(100, ratio)) : null;
  const segs: ReadonlyArray<MetricBarSegment> = hasSegments
    ? (segments as ReadonlyArray<MetricBarSegment>)
    : ratioNum !== null
      ? [{ percent: ratioNum, color: 'var(--color-secondary-500)' }]
      : [];

  return (
    <span
      className={['metric-bar', className].filter(Boolean).join(' ')}
      role="img"
      aria-label={label}
    >
      {segs.map((seg, i) => (
        <span
          key={`metric-bar-seg-${i}`}
          className="metric-bar__seg"
          style={{ width: `${seg.percent}%`, background: seg.color }}
        />
      ))}
    </span>
  );
}
