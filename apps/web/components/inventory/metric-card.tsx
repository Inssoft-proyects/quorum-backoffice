'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { DonutChart, type DonutSegment } from './donut-chart';

export interface MetricCardProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Label shown in the upper part of the card (e.g. "Total"). */
  label: string;
  /** Numeric value (large, bold). */
  value: number | string;
  /** Optional kicker text rendered below the value (e.g. "Inventario"). */
  meta?: string;
  /** Donut segments for the chart in the bottom-right corner. */
  segments?: ReadonlyArray<DonutSegment>;
  /** When true, the card adopts the dark secondary-600 styling. */
  active?: boolean;
  /** Override the centre label of the donut. Defaults to "100%". */
  centerLabel?: string;
  /** Optional sub-label rendered next to the value (e.g. "Solo el 2%"). */
  percentageLabel?: string;
  /**
   * Donut variant override. The maquette's "Total" card carries white
   * separator bands between segments; pass "total" to enable them.
   * Defaults to "generic" (no separators).
   */
  chartVariant?: 'generic' | 'total';
  /**
   * Two pill entries rendered in the meta region when the card carries the
   * "attention" emphasis. Ignored otherwise.
   */
  pills?: ReadonlyArray<{ label: string; variant: 'warning' | 'danger' }>;
  children?: React.ReactNode;
}

/**
 * Metric card matching the marbetes maquette (Total / Disponibles /
 * Asignados / Por atender). Acts as a button so it can be wired to the
 * top-level state machine that switches the active filter. The donut chart
 * and the two-tone meta row are rendered conditionally — "Por atender"
 * uses the `pills` slot to show "Próximos / Vencidos" mini-pills.
 */
export const MetricCard = React.forwardRef<HTMLButtonElement, MetricCardProps>(
  (
    {
      label,
      value,
      meta,
      segments,
      active = false,
      centerLabel = '100%',
      percentageLabel,
      chartVariant = 'generic',
      pills,
      className,
      children,
      type = 'button',
      ...props
    },
    ref,
  ) => {
    const hasChart = Array.isArray(segments) && segments.length > 0;
    const isAttention = Boolean(pills && pills.length > 0);
    return (
      <button
        ref={ref}
        type={type}
        aria-pressed={active}
        data-filter={label.toLowerCase()}
        className={cn(
          'metric-card',
          hasChart && 'metric-card--with-chart',
          isAttention && 'metric-card--attention',
          className,
        )}
        {...props}
      >
        <span className="metric-card__label">{label}</span>
        {!active ? (
          <span className="metric-card__filter-chip" data-filter-chip>
            {active ? 'Filtro activo' : 'Filtrar'}
          </span>
        ) : (
          <span className="metric-card__filter-chip" data-filter-chip>
            Filtro activo
          </span>
        )}
        {percentageLabel ? (
          <span className="metric-card__value-row">
            <span className="metric-card__value">{value}</span>
            <span className="metric-card__percentage" aria-label={percentageLabel}>
              <b>Solo el </b>
              {percentageLabel}
            </span>
          </span>
        ) : (
          <span className="metric-card__value">{value}</span>
        )}
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
        {hasChart ? (
          <DonutChart
            className="metric-card__chart"
            segments={segments as DonutSegment[]}
            centerLabel={centerLabel}
            variant={chartVariant}
          />
        ) : null}
      </button>
    );
  },
);
MetricCard.displayName = 'MetricCard';
