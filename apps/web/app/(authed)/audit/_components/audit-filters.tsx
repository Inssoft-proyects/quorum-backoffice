'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition, type ChangeEvent } from 'react';
import { Input } from '@/components/ui/input';

const ENTITY_TYPES: Array<{ value: string; label: string }> = [
  { value: '', label: 'Todos' },
  { value: 'marbete', label: 'Marbete' },
  { value: 'dispositivo', label: 'Dispositivo' },
  { value: 'session', label: 'Sesión' },
];

// Full AuditAction enum (12 values) + an "Todas" lead-in. Kept in sync
// with `packages/shared/src/dto/audit.ts` AuditAction.
const ACTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Todas' },
  { value: 'marbete.create', label: 'Marbete crear' },
  { value: 'marbete.update', label: 'Marbete editar' },
  { value: 'marbete.delete', label: 'Marbete eliminar' },
  { value: 'marbete.assign', label: 'Marbete asignar' },
  { value: 'marbete.reveal', label: 'Marbete revelar' },
  { value: 'marbete.bulk_create', label: 'Marbete carga masiva' },
  { value: 'dispositivo.create', label: 'Disp. crear' },
  { value: 'dispositivo.update', label: 'Disp. editar' },
  { value: 'dispositivo.revoke', label: 'Disp. revocar' },
  { value: 'auth.login', label: 'Login' },
  { value: 'auth.logout', label: 'Logout' },
  { value: 'auth.failed', label: 'Login fallido' },
];

function toIso(localValue: string): string {
  if (!localValue) return '';
  const d = new Date(localValue);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

interface Props {
  /**
   * Pre-formatted label rendered in the `.inventory-search__count`
   * slot. The page client decides how to combine the filtered count
   * and the server-side total. Defaults to `"(0)"` to keep existing
   * tests (which render <AuditFilters /> without props) green.
   */
  countLabel?: string;
}

/**
 * The audit log filter shell (v2 — maquette pattern).
 *
 * Composed of two visual blocks:
 *   - `.inventory-search` shell hosts the free-text search input and the
 *     live result count (`audit-filters` testid preserved).
 *   - `.grid` row hosts the five structured filters (entityType, action,
 *     actorId, since, until).
 *
 * URL-driven via `startTransition` + `router.replace` so filtered views
 * are shareable / bookmarkable and the server component re-fetches with
 * the new query.
 */
export function AuditFilters({ countLabel = '(0)' }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const entityType = searchParams.get('entityType') ?? '';
  const action = searchParams.get('action') ?? '';
  const actorId = searchParams.get('actorId') ?? '';
  const search = searchParams.get('search') ?? '';
  const since = searchParams.get('since') ?? '';
  const until = searchParams.get('until') ?? '';
  const [isPending, startTransition] = useTransition();

  function updateParam(key: string, value: string): void {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    startTransition(() => router.replace(`/audit?${next.toString()}`));
  }

  return (
    <>
      <div className="inventory-search" role="search" data-testid="audit-filters">
        <span className="inventory-search__icon" aria-hidden />
        <input
          id="filter-search"
          className="inventory-search__input"
          type="search"
          autoComplete="off"
          placeholder="entity_id, otp_id, ..."
          defaultValue={search}
          onChange={(e) => updateParam('search', e.target.value)}
          disabled={isPending}
          data-testid="filter-search"
          aria-label="Búsqueda libre"
        />
        <span className="inventory-search__count" aria-live="polite">
          {countLabel}
        </span>
      </div>
      <div
        className="mt-3 grid gap-3 md:grid-cols-3 lg:grid-cols-5"
        data-testid="audit-filters-extra"
      >
        <div className="custom-select">
          <label htmlFor="filter-entity-type" className="sr-only">
            Tipo de entidad
          </label>
          <select
            id="filter-entity-type"
            value={entityType}
            onChange={(e: ChangeEvent<HTMLSelectElement>) =>
              updateParam('entityType', e.target.value)
            }
            disabled={isPending}
            className="custom-select__trigger"
            data-testid="filter-entity-type"
            aria-label="Tipo de entidad"
          >
            {ENTITY_TYPES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="custom-select">
          <label htmlFor="filter-action" className="sr-only">
            Acción
          </label>
          <select
            id="filter-action"
            value={action}
            onChange={(e: ChangeEvent<HTMLSelectElement>) =>
              updateParam('action', e.target.value)
            }
            disabled={isPending}
            className="custom-select__trigger"
            data-testid="filter-action"
            aria-label="Acción"
          >
            {ACTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="filter-actor" className="text-xs text-text-muted">
            Actor ID
          </label>
          <Input
            id="filter-actor"
            type="text"
            placeholder="email o user id"
            defaultValue={actorId}
            onChange={(e) => updateParam('actorId', e.target.value)}
            disabled={isPending}
            data-testid="filter-actor"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="filter-since" className="text-xs text-text-muted">
            Desde
          </label>
          <Input
            id="filter-since"
            type="datetime-local"
            defaultValue={since}
            onChange={(e) => updateParam('since', toIso(e.target.value))}
            disabled={isPending}
            data-testid="filter-since"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="filter-until" className="text-xs text-text-muted">
            Hasta
          </label>
          <Input
            id="filter-until"
            type="datetime-local"
            defaultValue={until}
            onChange={(e) => updateParam('until', toIso(e.target.value))}
            disabled={isPending}
            data-testid="filter-until"
          />
        </div>
      </div>
    </>
  );
}
