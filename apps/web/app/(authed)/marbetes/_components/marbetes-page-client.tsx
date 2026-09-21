'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { MarbeteDetailResponse, UserRole } from '@quorum-backoffice/shared';
import { Button } from '@/components/ui/button';
import { MarbetesTable } from './marbetes-table';
import { DeleteDialog } from './delete-dialog';
import { CreateDialog } from './create-dialog';
import { EditDialog } from './edit-dialog';

interface Props {
  items: MarbeteDetailResponse[];
  userRole: UserRole;
  total: number;
}

/**
 * Client wrapper that owns the local state for the table and all three
 * dialogs (create / edit / delete). The actual data fetch happens in the
 * parent server component; after any successful mutation we call
 * `router.refresh()` so the server re-renders with the new state.
 */
export function MarbetesPageClient({ items, userRole, total }: Props) {
  const router = useRouter();
  const [toDelete, setToDelete] = useState<MarbeteDetailResponse | null>(null);
  const [editing, setEditing] = useState<MarbeteDetailResponse | null>(null);
  const [creating, setCreating] = useState(false);

  const isAdmin = userRole === 'admin';

  return (
    <>
      <div className="flex items-center justify-between">
        <span className="text-sm text-text-muted">
          {total} marbete{total === 1 ? '' : 's'}
        </span>
        {isAdmin ? (
          <Button onClick={() => setCreating(true)} data-testid="open-create">
            Crear marbete
          </Button>
        ) : null}
      </div>
      <MarbetesTable
        items={items}
        userRole={userRole}
        onDelete={setToDelete}
        onEdit={setEditing}
      />
      <DeleteDialog
        marbete={toDelete}
        onClose={() => setToDelete(null)}
        onSuccess={() => router.refresh()}
      />
      <EditDialog
        marbete={editing}
        onClose={() => setEditing(null)}
        onSuccess={() => router.refresh()}
      />
      <CreateDialog
        open={creating}
        onClose={() => setCreating(false)}
        onSuccess={() => router.refresh()}
      />
    </>
  );
}