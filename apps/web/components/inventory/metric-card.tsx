'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { AnimatedCounter } from './animated-counter';
import { MetricBar, type MetricBarSegment } from './metric-bar';

export interface MetricCardProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'children'
> {
  /** Label shown in the upper part of the card (e.g. "Total"). Clipped
   * to a single line with ellipsis; the full text lives on the `title`
   * attribute so screen-reader / tooltip access stays intact. */
  label: string;
  /** Numeric value (large, bold). Wrapped in `nowrap` so the digits
   * never break across lines. */
  value: number | string;
  /** Optional kicker text rendered below the value (e.g. "Inventario")
   * or the row host for the attention-card `pills`. */
  meta?: string;
  /** Proportional bar segments. The donut was retired in favour of a
   * compact horizontal bar (see `metric-bar.tsx`). */
  segments?: ReadonlyArray<MetricBarSegment>;
  /** When true, the card adopts the dark secondary-600 styling and
   * `aria-pressed="true"`. Consumed by the inventory state machine. */
  active?: boolean;
  /** Share text rendered next to the value, e.g. "100%" or "65%". */
  ratioLabel?: string;
  /** Optional single-share (0-100) used by `metric-bar` when `segments`
   * is absent; typical attention / dashboard cards pass a calculated
   * ratio without an explicit `segments` array. */
  ratio?: number;
  /** Optional sub-label rendered next to the value (e.g. "Solo el 2%"
   * prefix copy). Currently used by the attention card alongside the
   * `ratio` figure. */
  percentageLabel?: string;
  /** Accessible description for the percentage slot (canon uses a fuller
   * sentence than the visible text, e.g. "2% del inventario requiere
   * atención" vs. the visible "Solo el 2% del total"). */
  percentageAriaLabel?: string;
  /**
   * Two pill entries rendered in the meta region when the card carries
   * the "attention" emphasis. Ignored otherwise.
   */
  pills?: ReadonlyArray<{ label: string; variant: 'warning' | 'danger' }>;
  children?: React.ReactNode;
}

/**
 * Metric card matching the marbetes maquette v3
 * (Total / Disponibles / Asignados / Por atender). Acts as a button so
 * it can be wired to the top-level state machine that switches the
 * active filter.
 *
 * Layout: a single CSS grid with areas `label chip / value ratio /
 * meta meta / bar bar`. The filter chip is a static grid-area item —
 * no absolute positioning — and the bar replaces the old donut so the
 * cards no longer need a 195 px-tall hero. The DOM contract that the
 * e2e and unit suites rely on is preserved exactly:
 * - `aria-pressed={active}`
 * - `data-filter={label.toLowerCase()}`
 * - `data-filter-chip` on the chip
 * - every `data-testid` / `aria` passthrough from the spread props.
 */
export const MetricCard = React.forwardRef<HTMLButtonElement, MetricCardProps>(
  (
    {
      label,
      value,
      meta,
      segments,
      active = false,
      ratioLabel,
      ratio,
      percentageLabel,
      percentageAriaLabel,
      pills,
      className,
      children,
      type = 'button',
      ...props
    },
    ref,
  ) => {
    const hasSegments = Array.isArray(segments) && segments.length > 0;
    const hasRatio = typeof ratio === 'number';
    const hasBar = hasSegments || hasRatio;
    const isAttention = Boolean(pills && pills.length > 0);
    const showRatioSlot = Boolean(ratioLabel) || Boolean(percentageLabel);
    return (
      <button
        ref={ref}
        type={type}
        aria-pressed={active}
        data-filter={label.toLowerCase()}
        className={cn('metric-card', isAttention && 'metric-card--attention', className)}
        {...props}
      >
        <span className="metric-card__label" title={label}>
          {label}
        </span>
        <span className="metric-card__filter-chip" data-filter-chip>
          {active ? 'Filtro activo' : 'Filtrar'}
        </span>
        <span className="metric-card__value">
          {typeof value === 'number' ? <AnimatedCounter value={value} label={label} /> : value}
        </span>
        {showRatioSlot ? (
          percentageLabel ? (
            <span
              className="metric-card__ratio metric-card__percentage"
              aria-label={percentageAriaLabel ?? percentageLabel}
            >
              <b>Solo el </b>
              {percentageLabel}
            </span>
          ) : (
            <span className="metric-card__ratio">{ratioLabel}</span>
          )
        ) : null}
        {pills && pills.length > 0 ? (
          <span className="metric-card__meta" aria-label={pills.map((p) => p.label).join(' / ')}>
            {pills.map((p, i) => (
              <span
                key={`${p.label}-${i}`}
                className={cn(
                  'metric-card__meta-pill',
                  p.variant === 'warning'
                    ? 'metric-card__meta-pill--warning'
                    : 'metric-card__meta-pill--danger',
                )}
              >
                {p.label}
              </span>
            ))}
          </span>
        ) : meta ? (
          <span className="metric-card__meta">{meta}</span>
        ) : null}
        {children}
        {hasBar ? (
          <MetricBar
            className="metric-card__bar"
            segments={hasSegments ? segments : undefined}
            {...(hasRatio ? { ratio } : {})}
            label={label}
          />
        ) : null}
      </button>
    );
  },
);
MetricCard.displayName = 'MetricCard';
