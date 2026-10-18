'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition, type ChangeEvent } from 'react';
import { Field } from '@/components/ui/field';

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Todos' },
  { value: 'active', label: 'Activos' },
  { value: 'inactive', label: 'Inactivos' },
  { value: 'revoked', label: 'Revocados' },
];

/**
 * Reads and writes the marbetes list filters through the URL search params
 * so that filtered views are shareable / bookmarkable. Uses startTransition
 * to keep the UI responsive while the server component re-renders.
 */
export function MarbetesFilters() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const status = searchParams.get('status') ?? '';
  const search = searchParams.get('search') ?? '';
  const [isPending, startTransition] = useTransition();

  function updateParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    startTransition(() => router.replace(`/marbetes?${next.toString()}`));
  }

  function handleStatus(e: ChangeEvent<HTMLSelectElement>) {
    updateParam('status', e.target.value);
  }
  function handleSearch(value: string) {
    updateParam('search', value);
  }

  return (
    <div className="flex flex-wrap items-end gap-3" data-testid="marbetes-filters">
      <div className="flex flex-col gap-1">
        <label htmlFor="filter-status" className="text-xs text-text-muted">
          Estado
        </label>
        <select
          id="filter-status"
          value={status}
          onChange={handleStatus}
          disabled={isPending}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex min-w-[200px] flex-1 flex-col gap-1">
        <Field
          id="filter-search"
          type="search"
          label="Buscar por UID"
          placeholder="m-AB12CD"
          defaultValue={search}
          onChange={handleSearch}
          disabled={isPending}
        />
      </div>
    </div>
  );
}
