import type { ReactNode } from 'react';
import type { MeResponse } from '@quorum-backoffice/shared';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';

/**
 * Authed app shell: sidebar (md+) + topbar (with mobile hamburger) +
 * main content area. Server component. The grid collapses to a single
 * column below the `md` breakpoint (768px) so the sidebar can be
 * replaced by the MobileNav drawer without forcing horizontal overflow
 * at 360px viewports (RESP-001).
 */
export function AppShell({ user, children }: { user: MeResponse; children: ReactNode }) {
  return (
    <div className="grid min-h-screen grid-cols-1 bg-background md:grid-cols-[16rem_1fr]">
      <Sidebar user={user} className="hidden md:flex" />
      <div className="flex min-w-0 flex-col">
        <Topbar user={user} />
        <main className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}