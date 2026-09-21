'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { MarbeteDetailResponse, UserRole } from '@quorum-backoffice/shared';
import { MarbetesTable } from './marbetes-table';
import { DeleteDialog } from './delete-dialog';

interface Props {
  items: MarbeteDetailResponse[];
  userRole: UserRole;
  total: number;
}

/**
 * Client wrapper that holds the local state needed for the table +
 * delete dialog. The actual data fetch happens in the parent server
 * component; after a successful delete we call `router.refresh()` so
 * the server re-renders with the new state.
 */
export function MarbetesPageClient({ items, userRole, total }: Props) {
  const router = useRouter();
  const [toDelete, setToDelete] = useState<MarbeteDetailResponse | null>(null);

  return (
    <>
      <div className="flex items-center justify-between text-sm text-text-muted">
        <span>
          {total} marbete{total === 1 ? '' : 's'}
        </span>
      </div>
      <MarbetesTable items={items} userRole={userRole} onDelete={setToDelete} />
      <DeleteDialog
        marbete={toDelete}
        onClose={() => setToDelete(null)}
        onSuccess={() => router.refresh()}
      />
    </>
  );
}
