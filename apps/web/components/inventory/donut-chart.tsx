'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface DonutSegment {
  /** 0-100; the array must sum to 100. */
  percent: number;
  /** Any CSS color. */
  color: string;
}

export interface DonutChartProps {
  segments: ReadonlyArray<DonutSegment>;
  /** Diameter in px. Defaults to 64. */
  size?: number;
  /** Text rendered in the centre of the donut (e.g. "100%"). */
  centerLabel?: string;
  className?: string;
}

/**
 * Inline donut chart used by the marbetes metric cards.
 *
 * Implementation: a CSS conic-gradient on a circular layer (the donut "ring")
 * with a smaller white circle overlay in the middle to create the hole and
 * host the centre label. Renders to <span> + CSS so it works in any
 * environment without SVG / JS charting deps.
 */
export function DonutChart({
  segments,
  size = 64,
  centerLabel,
  className,
}: DonutChartProps) {
  // Build the conic-gradient stop list; entries come in order, each
  // spanning `percent` percent of the circle. The values are multiplied by
  // 3.6 to convert percent to degrees and offset by the running total.
  const stops: string[] = [];
  let running = 0;
  for (const seg of segments) {
    const startDeg = running * 3.6;
    running += seg.percent;
    const endDeg = running * 3.6;
    stops.push(`${seg.color} ${startDeg}deg ${endDeg}deg`);
  }
  const gradient = `conic-gradient(from -90deg, ${stops.join(', ')})`;

  return (
    <span
      className={cn('donut-chart', className)}
      style={{
        width: `${size}px`,
        background: gradient,
      }}
      role="img"
    >
      {centerLabel !== undefined ? (
        <span className="donut-chart__value">{centerLabel}</span>
      ) : null}
    </span>
  );
}
