'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
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
 * Maquette-style pagination: a compact "Mostrando X–Y de Z · Página N de M"
 * pill that expands a panel with rows-per-page selector, range/page
 * summary and Anterior / Siguiente buttons. The toggle is only shown at
 * small viewports (handled via the `.table-pagination__toggle` rule).
 */
export function Pagination({
  currentPage,
  pageSize,
  totalItems,
  onPageChange,
  onPageSizeChange,
}: PaginationProps) {
  const effectiveSize = pageSize === 'all' ? totalItems : pageSize;
  const totalPages =
    pageSize === 'all' || totalItems === 0
      ? 1
      : Math.max(1, Math.ceil(totalItems / pageSize));
  const start = totalItems === 0 ? 0 : (currentPage - 1) * effectiveSize + 1;
  const end = Math.min(currentPage * effectiveSize, totalItems);
  const rangeText =
    totalItems === 0
      ? 'Mostrando 0 de 0'
      : `Mostrando ${start}–${end} de ${totalItems}`;

  const [expanded, setExpanded] = React.useState(false);

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

        <div
          className={cn(
            'table-pagination__panel',
            expanded && 'is-expanded',
          )}
        >
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
            <span className="table-pagination__range" data-testid="pagination-range">{rangeText}</span>
            <span className="table-pagination__page" data-testid="pagination-page">
              Página {currentPage} de {totalPages}
            </span>
          </div>
          <div className="table-pagination__navigation">
            <button
              type="button"
              className="btn btn--secondary row-action"
              onClick={() => onPageChange(currentPage - 1)}
              disabled={currentPage <= 1}
              data-testid="pagination-prev"
            >
              <ChevronLeft className="row-action__icon" aria-hidden />
              Anterior
            </button>
            <button
              type="button"
              className="btn btn--secondary row-action"
              onClick={() => onPageChange(currentPage + 1)}
              disabled={currentPage >= totalPages}
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
