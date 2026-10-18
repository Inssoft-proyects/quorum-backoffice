'use client';

import * as React from 'react';
import { ValueFlash } from '@/components/interior/value-flash';

/**
 * Counter with interior.dev's Value Flash
 * (https://www.interior.dev/docs/value-flash).
 *
 * Server components can hand a plain number to this client leaf. When the
 * number changes — a marbete created, a device revoked, a filter refetch —
 * the new digits roll in from the direction of the change, the value tints,
 * and the change is announced once (`aria-live="polite"`) after it settles,
 * so a screen reader hears the final number instead of every intermediate
 * render.
 *
 * Not a chart and not a badge: it exists so "a number changed" stops being
 * invisible.
 */
export function AnimatedCounter({
  value,
  label,
  className,
}: {
  value: number;
  /** Accessible name, e.g. "Marbetes OK". */
  label?: string;
  className?: string;
}) {
  return (
    <ValueFlash
      value={value}
      label={label}
      // Raw digits: the maquette renders the count without grouping.
      format={(next) => String(next)}
      className={className}
    />
  );
}

AnimatedCounter.displayName = 'AnimatedCounter';
