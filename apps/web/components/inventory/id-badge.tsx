import * as React from 'react';
import { cn } from '@/lib/utils';

export interface IdBadgeProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'id'> {
  /** Internal marbete id. Auto-formatted as `CRD-${id.padStart(4,'0')}`. */
  marbeteId?: number;
  /** Override the formatted value when needed (e.g. tests / fixtures). */
  value?: string;
}

/**
 * Marbete identifier badge (CRD-####) styled with the maquette
 * `.id-badge` class: light blue outline, assigned-text colour, rounded
 * sm corner. Used in the table ID column.
 */
export function IdBadge({ marbeteId, value, className, ...props }: IdBadgeProps) {
  const display = value ?? (typeof marbeteId === 'number' ? `CRD-${String(marbeteId).padStart(4, '0')}` : '');
  return (
    <span className={cn('id-badge', className)} {...props}>
      {display}
    </span>
  );
}
