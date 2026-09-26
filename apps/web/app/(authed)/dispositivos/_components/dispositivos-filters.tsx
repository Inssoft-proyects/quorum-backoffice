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
  /** Whether the underlying fetch is in flight (disables the select). */
  isPending?: boolean;
}

/**
 * Status filter for the dispositivos list (maquette v2).
 *
 * Reads and writes the `status` URL search param via
 * `startTransition` + `router.replace` so filtered views are
 * shareable / bookmarkable and the server component re-fetches with
 * the new query.
 *
 * Rendered as a child of `DispositivosPageClient`, OUTSIDE the
 * `.inventory-section__header` so the section header keeps the
 * canonical maquette structure (`<h2>` + `.inventory-search` shell
 * only — see `credential-inventory.css`).
 */
export function DispositivosFilters({ isPending }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const status = searchParams.get('status') ?? '';
  const [pending, startTransition] = useTransition();

  const disabled = isPending ?? pending;

  function updateParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    startTransition(() => router.replace(`/dispositivos?${next.toString()}`));
  }

  function handleStatus(e: ChangeEvent<HTMLSelectElement>) {
    updateParam('status', e.target.value);
  }

  return (
    <div className="custom-select" style={{ minWidth: '10rem' }}>
      <label htmlFor="filter-status" className="sr-only">
        Estado
      </label>
      <select
        id="filter-status"
        value={status}
        onChange={handleStatus}
        disabled={disabled}
        className="custom-select__trigger"
        data-testid="filter-status"
        aria-label="Estado"
      >
        {STATUS_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}