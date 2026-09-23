'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { Input } from '@/components/ui/input';

/**
 * Audit log filters (WU10).
 *
 * Reads and writes the filter state through the URL search params so that
 * filtered views are shareable / bookmarkable. Mirrors the dispositivos /
 * marbetes filter pattern: `startTransition` keeps the UI responsive while
 * the server component re-renders with the new filter values.
 *
 * Filters: entityType (marbete/dispositivo/session), action (subset of the
 * AuditAction enum), actorId (email or user id), since/until (datetime-local
 * converted to ISO), and a free-text search.
 */
const ENTITY_TYPES: Array<{ value: string; label: string }> = [
  { value: '', label: 'Todos' },
  { value: 'marbete', label: 'Marbete' },
  { value: 'dispositivo', label: 'Dispositivo' },
  { value: 'session', label: 'Sesión' },
];

// AuditAction subset for the dropdown; the full set is reachable via the
// free-text search field. Keep this list in sync with packages/shared/dto/audit.
const ACTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Todas' },
  { value: 'marbete.create', label: 'Marbete crear' },
  { value: 'marbete.update', label: 'Marbete editar' },
  { value: 'marbete.delete', label: 'Marbete eliminar' },
  { value: 'marbete.assign', label: 'Marbete asignar' },
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

export function AuditFilters() {
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
    <div
      className="grid gap-3 md:grid-cols-3 lg:grid-cols-6"
      data-testid="audit-filters"
    >
      <div className="flex flex-col gap-1">
        <label htmlFor="filter-entity-type" className="text-xs text-text-muted">
          Tipo de entidad
        </label>
        <select
          id="filter-entity-type"
          value={entityType}
          onChange={(e) => updateParam('entityType', e.target.value)}
          disabled={isPending}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          data-testid="filter-entity-type"
        >
          {ENTITY_TYPES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="filter-action" className="text-xs text-text-muted">
          Acción
        </label>
        <select
          id="filter-action"
          value={action}
          onChange={(e) => updateParam('action', e.target.value)}
          disabled={isPending}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          data-testid="filter-action"
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
      <div className="flex flex-col gap-1">
        <label htmlFor="filter-search" className="text-xs text-text-muted">
          Búsqueda libre
        </label>
        <Input
          id="filter-search"
          type="search"
          placeholder="entity_id, otp_id, ..."
          defaultValue={search}
          onChange={(e) => updateParam('search', e.target.value)}
          disabled={isPending}
          data-testid="filter-search"
        />
      </div>
    </div>
  );
}