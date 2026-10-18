'use client';

import * as React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePagination } from '@/components/interior/pagination';
import { Select } from '@/components/ui/select';

export type PageSize = number | 'all';

export interface PaginationProps {
  currentPage: number; // 1-indexed
  pageSize: PageSize;
  totalItems: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: PageSize) => void;
}

/**
 * Maquette-style pagination with interior.dev's Pagination mechanics
 * (https://www.interior.dev/docs/pagination).
 *
 * The equivalent guarantee is "the window moves, the row does not": page
 * numbers live in fixed-width slots, so going from 9 to 10 or growing the
 * page count never reflows the bar, and the selected-page thumb springs from
 * slot to slot instead of disappearing and redrawing. `usePagination` owns
 * the window (siblings/boundaries) and the thumb index.
 *
 * The maquette shell — the `Mostrando X–Y de Z · Página N de M` summary, the
 * rows-per-page selector, the `.table-pagination` classes and every
 * `data-testid` — is preserved because the table suites and the Playwright
 * parity harness read it.
 */

const SLOT = 32;
const GAP = 4;
const CELL = { type: 'spring', stiffness: 520, damping: 36, mass: 0.6 } as const;
const STILL = { duration: 0 } as const;

export function Pagination({
  currentPage,
  pageSize,
  totalItems,
  onPageChange,
  onPageSizeChange,
}: PaginationProps) {
  const effectiveSize = pageSize === 'all' ? totalItems : pageSize;
  const totalPages =
    pageSize === 'all' || totalItems === 0 ? 1 : Math.max(1, Math.ceil(totalItems / pageSize));
  const start = totalItems === 0 ? 0 : (currentPage - 1) * effectiveSize + 1;
  const end = Math.min(currentPage * effectiveSize, totalItems);
  const rangeText =
    totalItems === 0 ? 'Mostrando 0 de 0' : `Mostrando ${start}–${end} de ${totalItems}`;

  const [expanded, setExpanded] = React.useState(false);
  const reduced = useReducedMotion();

  const pager = usePagination({
    count: totalPages,
    page: currentPage,
    siblings: 1,
    boundaries: 1,
    onPageChange,
  });

  function handleSize(value: string) {
    onPageSizeChange(value === 'all' ? 'all' : Number(value));
  }

  const sizeOptions = [
    { value: '5', label: '5' },
    { value: '10', label: '10' },
    { value: '15', label: '15' },
    { value: 'all', label: 'Todas' },
  ];

  return (
    <nav className="table-pagination" aria-label="Paginación de la tabla">
      <div className="table-pagination__inner">
        <button
          type="button"
          className="table-pagination__toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <span className="table-pagination__toggle-copy">
            <span className="table-pagination__toggle-label">Paginación</span>
            <span className="table-pagination__toggle-detail">
              {rangeText} · Página {currentPage} de {totalPages}
            </span>
          </span>
          <span className="table-pagination__toggle-icon" aria-hidden />
        </button>

        <div className={cn('table-pagination__panel', expanded && 'is-expanded')}>
          <div className="table-pagination__summary">
            <div className="field-inline">
              <label htmlFor="inventory-page-size">Filas por página</label>
              <Select
                id="inventory-page-size"
                options={sizeOptions}
                value={pageSize === 'all' ? 'all' : String(pageSize)}
                onChange={(e) => handleSize(e.target.value)}
              />
            </div>
            <span className="table-pagination__range" data-testid="pagination-range">
              {rangeText}
            </span>
            <span className="table-pagination__page" data-testid="pagination-page">
              Página {currentPage} de {totalPages}
            </span>
          </div>
          <div className="table-pagination__navigation">
            <button
              type="button"
              className="btn btn--secondary row-action"
              onClick={() => pager.prev()}
              disabled={!pager.canPrev}
              data-testid="pagination-prev"
            >
              <ChevronLeft className="row-action__icon" aria-hidden />
              Anterior
            </button>

            <div className="relative" aria-label="Página">
              <motion.span
                aria-hidden
                initial={false}
                animate={{ x: Math.max(0, pager.thumbIndex) * (SLOT + GAP) }}
                transition={reduced ? STILL : CELL}
                style={{ width: SLOT }}
                className="absolute inset-y-0 left-0 rounded-md bg-primary-500/10 ring-1 ring-primary-500/40"
              />
              <ol className="relative flex" style={{ gap: GAP }}>
                {pager.items.map((item) => {
                  if (typeof item !== 'number') {
                    return (
                      <li
                        key={item}
                        aria-hidden
                        style={{ width: SLOT }}
                        className="flex h-8 items-center justify-center text-xs text-text-muted"
                      >
                        &hellip;
                      </li>
                    );
                  }
                  const selected = item === currentPage;
                  return (
                    <li key={`page-${item}`} style={{ width: SLOT }}>
                      <button
                        type="button"
                        aria-label={`Página ${item}`}
                        aria-current={selected ? 'page' : undefined}
                        onClick={() => pager.goTo(item)}
                        className={cn(
                          'flex h-8 w-full items-center justify-center rounded-md text-xs tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                          selected
                            ? 'font-semibold text-primary-500'
                            : 'text-text-muted hover:text-text-primary',
                        )}
                      >
                        {item}
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>

            <button
              type="button"
              className="btn btn--secondary row-action"
              onClick={() => pager.next()}
              disabled={!pager.canNext}
              data-testid="pagination-next"
            >
              Siguiente
              <ChevronRight className="row-action__icon" aria-hidden />
            </button>
          </div>
        </div>
      </div>
    </nav>
  );
}
