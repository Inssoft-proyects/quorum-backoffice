import type { ReactNode } from 'react';
import type { MeResponse } from '@quorum-backoffice/shared';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';

/**
 * Authed app shell: sidebar + topbar + main content area.
 *
 * Server component. Rendered by the (authed) route group layout after
 * the session has been resolved.
 */
export function AppShell({ user, children }: { user: MeResponse; children: ReactNode }) {
  return (
    <div className="grid min-h-screen grid-cols-[16rem_1fr] bg-background">
      <Sidebar user={user} />
      <div className="flex flex-col">
        <Topbar user={user} />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}