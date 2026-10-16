'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition, type ChangeEvent } from 'react';

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
 * Composed of two rows: structured filters above a heading and search row.
 * The `audit-filters` test id remains on the search shell.
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
      <div
        className="audit-filters__fields"
        data-testid="audit-filters-extra"
      >
        <div className="audit-filters__field custom-select custom-select--compact">
          <label htmlFor="filter-entity-type" className="audit-filters__label">
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
          <span className="custom-select__chevron" aria-hidden="true" />
        </div>
        <div className="audit-filters__field custom-select custom-select--compact">
          <label htmlFor="filter-action" className="audit-filters__label">
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
          <span className="custom-select__chevron" aria-hidden="true" />
        </div>
        <div className="audit-filters__field">
          <label htmlFor="filter-actor" className="audit-filters__label">
            Actor ID
          </label>
          <input
            id="filter-actor"
            type="text"
            className="audit-filters__input"
            placeholder="Ej. admin"
            defaultValue={actorId}
            onChange={(e) => updateParam('actorId', e.target.value)}
            disabled={isPending}
            data-testid="filter-actor"
          />
        </div>
        <div className="audit-filters__field">
          <label htmlFor="filter-since" className="audit-filters__label">
            Desde
          </label>
          <input
            id="filter-since"
            type="datetime-local"
            className="audit-filters__input"
            defaultValue={since}
            onChange={(e) => updateParam('since', toIso(e.target.value))}
            disabled={isPending}
            data-testid="filter-since"
          />
        </div>
        <div className="audit-filters__field">
          <label htmlFor="filter-until" className="audit-filters__label">
            Hasta
          </label>
          <input
            id="filter-until"
            type="datetime-local"
            className="audit-filters__input"
            defaultValue={until}
            onChange={(e) => updateParam('until', toIso(e.target.value))}
            disabled={isPending}
            data-testid="filter-until"
          />
        </div>
      </div>
      <div className="inventory-section__header audit-filters__heading">
        <h2>Movimientos</h2>
        <div className="inventory-search" role="search" data-testid="audit-filters">
          <span className="inventory-search__icon" aria-hidden />
          <input
            id="filter-search"
            className="inventory-search__input"
            type="search"
            autoComplete="off"
            placeholder="Buscar actor, entidad o acción"
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
      </div>
    </>
  );
}
