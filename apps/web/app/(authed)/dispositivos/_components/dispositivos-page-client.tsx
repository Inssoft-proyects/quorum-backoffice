'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { DispositivoDetailResponse, UserRole } from '@quorum-backoffice/shared';
import { Button } from '@/components/ui/button';
import { DispositivosTable } from './dispositivos-table';
import { CreateDialog } from './create-dialog';
import { EditDialog } from './edit-dialog';
import { RevokeDialog } from './revoke-dialog';

interface Props {
  items: DispositivoDetailResponse[];
  userRole: UserRole;
  total: number;
}

/**
 * Client wrapper that owns the local state for the table and all three
 * dialogs (create / edit / revoke). The actual data fetch happens in the
 * parent server component; after any successful mutation we call
 * `router.refresh()` so the server re-renders with the new state.
 *
 * Mirror of marbetes-page-client.tsx, adapted to the dispositivos flow
 * (delete replaced by revoke; no student lookup; no counters card).
 */
export function DispositivosPageClient({ items, userRole, total }: Props) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<DispositivoDetailResponse | null>(null);
  const [toRevoke, setToRevoke] = useState<DispositivoDetailResponse | null>(null);

  const isAdmin = userRole === 'admin';

  return (
    <>
      <div className="flex items-center justify-between">
        <span className="text-sm text-text-muted">
          {total} dispositivo{total === 1 ? '' : 's'}
        </span>
        {isAdmin ? (
          <Button onClick={() => setCreating(true)} data-testid="open-create">
            Registrar dispositivo
          </Button>
        ) : null}
      </div>
      <DispositivosTable
        items={items}
        userRole={userRole}
        onEdit={setEditing}
        onRevoke={setToRevoke}
      />
      <CreateDialog
        open={creating}
        onClose={() => setCreating(false)}
        onSuccess={() => router.refresh()}
      />
      <EditDialog
        dispositivo={editing}
        onClose={() => setEditing(null)}
        onSuccess={() => router.refresh()}
      />
      <RevokeDialog
        dispositivo={toRevoke}
        onClose={() => setToRevoke(null)}
        onSuccess={() => router.refresh()}
      />
    </>
  );
}