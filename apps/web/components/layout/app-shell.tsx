'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { MeResponse } from '@quorum-backoffice/shared';
import { cn } from '@/lib/utils';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';

/**
 * Authed app shell: sidebar (md+) + topbar (with mobile hamburger) +
 * main content area.
 *
 * Client component because the sidebar collapse state has to reach the grid
 * track. It mirrors the pattern `components/theme-provider.tsx` already uses:
 * the value is hydrated from `localStorage` on mount and written on change, so
 * the server render and the first client render agree (expanded) and the
 * preference is restored right after.
 *
 * The grid collapses to a single column below the `md` breakpoint (768px) so
 * the sidebar can be replaced by the MobileNav drawer without forcing
 * horizontal overflow at 360px viewports (RESP-001). The desktop track is one
 * of two static utilities — 16rem expanded, 4.5rem in rail mode — transitioned
 * so the content does not jump. (A `var(--sidebar-track)` arbitrary value was
 * tried first and Tailwind 4 did not emit it, leaving the aside sized by
 * content.)
 */
const STORAGE_KEY = 'qb-sidebar-collapsed';

export function AppShell({ user, children }: { user: MeResponse; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(window.localStorage.getItem(STORAGE_KEY) === '1');
  }, []);

  const toggle = () => {
    setCollapsed((previous) => {
      const next = !previous;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      } catch {
        // Private mode / storage disabled: the rail still works for this
        // session, it just does not survive a reload.
      }
      return next;
    });
  };

  return (
    <div
      className={cn(
        'grid h-screen grid-cols-1 grid-rows-1 bg-background transition-[grid-template-columns] duration-150 ease-out motion-reduce:transition-none',
        collapsed ? 'md:grid-cols-[4.5rem_1fr]' : 'md:grid-cols-[16rem_1fr]',
      )}
    >
      <Sidebar user={user} className="hidden md:flex" collapsed={collapsed} onToggle={toggle} />
      <div className="flex min-w-0 flex-col">
        <Topbar user={user} />
        {/* h-screen + overflow-y-hidden here means the (authed) content
         * owns its own vertical scroll. Inventory-style pages keep the
         * table pagination pinned to the bottom of the visible viewport
         * (see .table-pagination rules in globals.css). The topbar +
         * sidebar remain pinned by the grid container; only <main>
         * scrolls internally for screens that opt in via the
         * `inventory-page` flex layout.
         *
         * The bottom padding is a constant 1rem and the inventory page adds
         * none: together with the 0 bottom padding on `.inventory-page` this
         * is the whole dead band left below the pagination (S2 of
         * `odd/tasks/backoffice-ui-canon.md`), so table screens spend ~98% of
         * the viewport height on content. */}
        <main className="min-w-0 flex-1 h-full overflow-x-hidden overflow-y-auto p-4 pb-4 md:px-6 md:pt-6 md:pb-4">
          {children}
        </main>
      </div>
    </div>
  );
}
