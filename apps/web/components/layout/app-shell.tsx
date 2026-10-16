import type { ReactNode } from 'react';
import type { MeResponse } from '@quorum-backoffice/shared';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';

/**
 * Authed app shell: sidebar (lg+) + topbar (with mobile hamburger) +
 * main content area. Server component. The grid collapses to a single
 * column below the `lg` breakpoint (1024px) so the sidebar can be
 * replaced by the MobileNav drawer without forcing horizontal overflow
 * at 360px viewports (RESP-001).
 */
export function AppShell({ user, children }: { user: MeResponse; children: ReactNode }) {
  return (
    <div className="app-shell grid h-screen grid-cols-1 grid-rows-1 bg-background lg:grid-cols-[auto_minmax(0,1fr)]">
      <Sidebar user={user} className="hidden lg:flex" />
      <div className="flex min-w-0 flex-col">
        <Topbar user={user} />
        {/* h-screen + overflow-y-hidden here means the (authed) content
         * owns its own vertical scroll. Inventory-style pages keep the
         * table pagination pinned to the bottom of the visible viewport
         * (see .table-pagination rules in globals.css). The topbar +
         * sidebar remain pinned by the grid container; only <main>
         * scrolls internally for screens that opt in via the
         * `inventory-page` flex layout. */}
        <main className="page-canvas min-w-0 flex-1 h-full overflow-x-hidden overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
