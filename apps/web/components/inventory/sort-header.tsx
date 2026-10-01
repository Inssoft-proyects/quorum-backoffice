'use client';

import * as React from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SortState {
  key: string;
  direction: 'asc' | 'desc';
}

export interface SortHeaderProps {
  label: string;
  sortKey: string;
  /** Current sort applied to the table, if any. */
  currentSort: SortState | null;
  onSort: (key: string) => void;
  align?: 'left' | 'right';
  className?: string;
  /** Accessible label announced by screen readers when activating the
   * sort button in the "ascending" direction. Matches the
   * maquette's `aria-label` on the `<button class="sort-button">`. */
  ariaLabel?: string;
  /** Sort state when the column is inactive. Defaults to "none". */
  ariaSortDefault?: 'none' | 'ascending' | 'descending';
}

/**
 * Sortable column header cell. Clicking cycles through asc / desc / none:
 *   - inactive → asc
 *   - asc      → desc
 *   - desc     → none (off)
 *
 * Arrows show the current state; both arrows are visible when inactive at
 * reduced opacity. Renders a <th> wrapping a <button> so it stays
 * keyboard-accessible and matches the maquette's sort-button pattern.
 */
export function SortHeader({
  label,
  sortKey,
  currentSort,
  onSort,
  align = 'left',
  className,
  ariaLabel,
  ariaSortDefault = 'none',
}: SortHeaderProps) {
  const isActive = currentSort?.key === sortKey;
  const direction = isActive ? currentSort?.direction : null;
  const dataAttr =
    direction === 'asc'
      ? 'ascending'
      : direction === 'desc'
        ? 'descending'
        : 'none';

  return (
    <th
      scope="col"
      className={cn('sortable-header', align === 'right' && 'text-right', className)}
      aria-sort={
        direction === 'asc'
          ? 'ascending'
          : direction === 'desc'
            ? 'descending'
            : ariaSortDefault
      }
      data-sort-key={sortKey}
    >
      <button
        type="button"
        className={cn('sort-button', isActive && 'is-active')}
        data-sort-direction={dataAttr}
        data-sort-key={sortKey}
        data-testid={`sort-${sortKey}`}
        aria-label={ariaLabel ?? `Ordenar ${label}`}
        onClick={() => onSort(sortKey)}
      >
        <span>{label}</span>
        <span className="sort-icon" aria-hidden>
          <ChevronUp
            className={cn(
              'h-3 w-3',
              direction === 'asc' ? 'text-text-primary' : 'text-text-muted-bold/50',
            )}
          />
          <ChevronDown
            className={cn(
              'h-3 w-3',
              direction === 'desc' ? 'text-text-primary' : 'text-text-muted-bold/50',
            )}
          />
        </span>
      </button>
    </th>
  );
}
