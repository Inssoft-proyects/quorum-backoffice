'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export type PageSize = number | 'all';

export interface PaginationProps {
  currentPage: number; // 1-indexed
  pageSize: PageSize;
  totalItems: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: PageSize) => void;
}

const sizeOptions = [
  { value: '5', label: '5' },
  { value: '10', label: '10' },
  { value: '15', label: '15' },
  { value: 'all', label: 'Todas' },
] as const;

/** Shared pagination footer, compacting into a scroll-revealed panel at 1024px and below. */
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
    totalItems === 0
      ? 'Mostrando 0 de 0'
      : pageSize === 'all'
        ? `Mostrando ${start}–${end}`
        : `Mostrando ${start}–${end} de ${totalItems}`;

  const [expanded, setExpanded] = React.useState(false);
  const [visible, setVisible] = React.useState(false);
  const [sizeMenuOpen, setSizeMenuOpen] = React.useState(false);
  const panelId = React.useId();
  const sizeControlRef = React.useRef<HTMLDivElement>(null);
  const sizeTriggerRef = React.useRef<HTMLButtonElement>(null);
  const sizeOptionRefs = React.useRef<(HTMLLIElement | null)[]>([]);
  const selectedSize = pageSize === 'all' ? 'all' : String(pageSize);
  const selectedSizeIndex = sizeOptions.findIndex((option) => option.value === selectedSize);

  React.useEffect(() => {
    if (sizeMenuOpen) sizeOptionRefs.current[Math.max(0, selectedSizeIndex)]?.focus();
  }, [sizeMenuOpen, selectedSizeIndex]);

  React.useEffect(() => {
    if (!sizeMenuOpen) return;

    const closeOutside = (event: Event) => {
      if (!sizeControlRef.current?.contains(event.target as Node)) setSizeMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('focusin', closeOutside);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('focusin', closeOutside);
    };
  }, [sizeMenuOpen]);

  React.useEffect(() => {
    const main = document.querySelector<HTMLElement>('main.page-canvas');
    if (!main || typeof window.matchMedia !== 'function') return;

    const compactQuery = window.matchMedia('(max-width: 64rem)');
    const updateVisibility = () => {
      if (!compactQuery.matches) {
        setVisible(true);
        setExpanded(false);
        setSizeMenuOpen(false);
        return;
      }

      const maxScroll = Math.max(0, main.scrollHeight - main.clientHeight);
      const threshold =
        maxScroll === 0 ? Infinity : Math.min(main.clientHeight * 0.2, Math.max(1, maxScroll - 1));
      const shouldShow = main.scrollTop >= threshold;
      setVisible(shouldShow);
      if (!shouldShow) {
        setExpanded(false);
        setSizeMenuOpen(false);
      }
    };
    const handleScroll = () => {
      setExpanded(false);
      setSizeMenuOpen(false);
      updateVisibility();
    };
    const handleResize = () => {
      setSizeMenuOpen(false);
      updateVisibility();
    };

    main.addEventListener('scroll', handleScroll, { passive: true });
    compactQuery.addEventListener('change', handleResize);
    window.addEventListener('resize', handleResize);
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateVisibility);
    observer?.observe(main);
    const page = main.querySelector('.inventory-page');
    if (page) observer?.observe(page);
    updateVisibility();

    return () => {
      main.removeEventListener('scroll', handleScroll);
      compactQuery.removeEventListener('change', handleResize);
      window.removeEventListener('resize', handleResize);
      observer?.disconnect();
    };
  }, [totalItems, pageSize]);

  function handleSize(value: string) {
    onPageSizeChange(value === 'all' ? 'all' : Number(value));
    setSizeMenuOpen(false);
    sizeTriggerRef.current?.focus();
  }

  function handleOptionKeyDown(event: React.KeyboardEvent<HTMLLIElement>, index: number) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      sizeOptionRefs.current[(index + step + sizeOptions.length) % sizeOptions.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      sizeOptionRefs.current[event.key === 'Home' ? 0 : sizeOptions.length - 1]?.focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const option = sizeOptions[index];
      if (option) handleSize(option.value);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setSizeMenuOpen(false);
      sizeTriggerRef.current?.focus();
    }
  }

  return (
    <nav
      className={cn('table-pagination', visible && 'is-visible')}
      aria-label="Paginación de la tabla"
    >
      <div className={cn('table-pagination__inner', expanded && 'is-expanded')}>
        <button
          type="button"
          className="table-pagination__toggle"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => {
            if (expanded) setSizeMenuOpen(false);
            setExpanded((v) => !v);
          }}
        >
          <span className="table-pagination__toggle-copy">
            <span className="table-pagination__toggle-label">Paginación</span>
            <span className="table-pagination__toggle-detail">
              {rangeText} · Página {currentPage} de {totalPages}
            </span>
          </span>
          <span className="table-pagination__toggle-icon" aria-hidden />
        </button>

        <div className="table-pagination__panel" id={panelId}>
          <div className="table-pagination__summary">
            <div className="field-inline">
              <label id={`${panelId}-size-label`} htmlFor={`${panelId}-size`}>
                Filas por página
              </label>
              <div className="custom-select" ref={sizeControlRef}>
                <button
                  ref={sizeTriggerRef}
                  className="custom-select__trigger"
                  id={`${panelId}-size`}
                  type="button"
                  aria-haspopup="listbox"
                  aria-expanded={sizeMenuOpen}
                  aria-controls={`${panelId}-size-options`}
                  aria-labelledby={`${panelId}-size-label ${panelId}-size-value`}
                  onClick={() => setSizeMenuOpen((open) => !open)}
                  onKeyDown={(event) => {
                    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
                      event.preventDefault();
                      setSizeMenuOpen(true);
                    } else if (event.key === 'Escape') {
                      setSizeMenuOpen(false);
                    }
                  }}
                >
                  <span id={`${panelId}-size-value`}>
                    {sizeOptions.find((option) => option.value === selectedSize)?.label}
                  </span>
                  <span className="custom-select__chevron" aria-hidden="true" />
                </button>
                <ul
                  className="custom-select__menu"
                  id={`${panelId}-size-options`}
                  role="listbox"
                  aria-label="Filas por página"
                  hidden={!sizeMenuOpen}
                >
                  {sizeOptions.map((option, index) => (
                    <li
                      key={option.value}
                      ref={(element) => {
                        sizeOptionRefs.current[index] = element;
                      }}
                      className="custom-select__option"
                      role="option"
                      tabIndex={-1}
                      aria-selected={option.value === selectedSize}
                      onClick={() => handleSize(option.value)}
                      onKeyDown={(event) => handleOptionKeyDown(event, index)}
                    >
                      {option.label}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <span className="table-pagination__range" data-testid="pagination-range">
              {rangeText}
            </span>
          </div>
          <div className="table-pagination__navigation" hidden={pageSize === 'all'}>
            <span className="table-pagination__page" data-testid="pagination-page">
              Página {currentPage} de {totalPages}
            </span>
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
