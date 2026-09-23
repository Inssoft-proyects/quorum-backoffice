import * as React from 'react';
import { cn } from '@/lib/utils';

export type StatusChipVariant = 'available' | 'assigned' | 'warning' | 'danger';

export interface StatusChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant: StatusChipVariant;
}

/**
 * Pill-shaped status indicator used in the marbetes table validity column
 * and the inventory maquette chip pattern.
 *
 * Variant → token mapping (from the maquette CSS):
 *   available → success-bg / success-text
 *   assigned  → white with assigned-border / assigned-text (no bullet)
 *   warning   → warning-bg / warning-text
 *   danger    → error-bg / error-text
 */
export function StatusChip({ variant, className, ...props }: StatusChipProps) {
  const variantClass =
    variant === 'available'
      ? 'chip--available'
      : variant === 'assigned'
        ? 'chip--assigned'
        : variant === 'warning'
          ? 'chip--warning'
          : 'chip--danger';

  // The `.chip` rule uses `::before` for the bullet; assigned and the
  // maquette's "Próxima a vencer / Vencida" still render a bullet, but the
  // maquette's chip--available / --warning / --danger pills show one.
  const showBullet = variant === 'available' || variant === 'warning' || variant === 'danger';
  return (
    <span
      className={cn('chip', variantClass, className)}
      style={showBullet ? undefined : { paddingLeft: '0.625rem' }}
      {...props}
    />
  );
}
