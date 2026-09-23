'use client';
import { useState } from 'react';
import type { AuditEntry } from '@quorum-backoffice/shared';
import { AuditTable } from './audit-table';
import { AuditDetailDrawer } from './audit-detail-drawer';

interface Props {
  items: AuditEntry[];
  total: number;
}

/**
 * Client wrapper for the audit log screen. Owns the local state for the
 * detail drawer (which audit entry is currently open). The data fetch
 * happens in the parent server component; this client only renders the
 * table + drawer and the result count.
 *
 * Mirror of dispositivos/marbetes page-client, stripped of any mutation
 * state since the audit log is read-only.
 */
export function AuditPageClient({ items, total }: Props) {
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  return (
    <>
      <div className="flex items-center justify-between">
        <span className="text-sm text-text-muted">
          {total} entrada{total === 1 ? '' : 's'}
        </span>
      </div>
      <AuditTable items={items} onSelect={setSelected} />
      <AuditDetailDrawer
        entry={selected}
        onClose={() => setSelected(null)}
      />
    </>
  );
}