'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition, type ChangeEvent } from 'react';

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Todos' },
  { value: 'active', label: 'Activos' },
  { value: 'revoked', label: 'Revocados' },
];

interface Props {
  /** Current search param (server-derived). Used for the input default value. */
  search: string;
  /**
   * Pre-formatted label rendered in the `.inventory-search__count`
   * slot. The page client decides how to combine the filtered count and
   * the server-side total.
   */
  countLabel: string;
}

/**
 * Reads and writes the dispositivos list filters (status + search) through
 * the URL search params so filtered views are shareable / bookmarkable.
 * Uses startTransition to keep the UI responsive while the server
 * component re-renders.
 *
 * Maquet v2 styling: the status select adopts the `.custom-select`
 * maquette trigger pattern (plain `<select>` with the
 * `.custom-select__trigger` class — no JS-driven menu needed) and the
 * search input is rendered in the `.inventory-search` shell with the
 * `inventory-section__header` row wrapper. Rendered as a child of
 * DispositivosPageClient.
 */
export function DispositivosFilters({ search, countLabel }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const status = searchParams.get('status') ?? '';
  const [isPending, startTransition] = useTransition();

  function updateParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    startTransition(() => router.replace(`/dispositivos?${next.toString()}`));
  }

  function handleStatus(e: ChangeEvent<HTMLSelectElement>) {
    updateParam('status', e.target.value);
  }
  function handleSearch(e: ChangeEvent<HTMLInputElement>) {
    updateParam('search', e.target.value);
  }

  return (
    <div className="inventory-section__header">
      <h2>Dispositivos registrados</h2>
      <div className="flex flex-wrap items-center gap-3">
        <div className="custom-select" style={{ minWidth: '10rem' }}>
          <select
            id="filter-status"
            value={status}
            onChange={handleStatus}
            disabled={isPending}
            className="custom-select__trigger"
            data-testid="filter-status"
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="inventory-search" role="search">
          <span className="inventory-search__icon" aria-hidden />
          <input
            className="inventory-search__input"
            type="search"
            autoComplete="off"
            placeholder="Buscar por serial, marca o modelo"
            defaultValue={search}
            onChange={handleSearch}
            disabled={isPending}
            data-testid="dispositivos-search"
            aria-label="Buscar dispositivo"
          />
          <span className="inventory-search__count" aria-live="polite">
            {countLabel}
          </span>
        </div>
      </div>
    </div>
  );
}