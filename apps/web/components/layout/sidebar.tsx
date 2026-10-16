'use client';

import { useState } from 'react';
import { ChevronsLeft, ChevronsRight } from 'lucide-react';
import type { MeResponse } from '@quorum-backoffice/shared';
import { cn } from '@/lib/utils';
import { BrandMark } from './brand-mark';
import { NavigationLinks } from './navigation-links';
import { LogoutButton } from './logout-button';

export function Sidebar({ user, className }: { user: MeResponse; className?: string }) {
  const [compact, setCompact] = useState(false);

  return (
    <aside
      className={cn(
        'relative min-h-0 shrink-0 flex-col overflow-visible border-r border-border bg-card px-3 py-2 transition-[width] duration-200',
        compact ? 'w-20' : 'w-64',
        className,
      )}
      data-testid="sidebar"
      data-compact={compact}
    >
      <div
        className={cn(
          'mb-3 flex min-h-9 items-center',
          compact ? 'justify-center' : 'justify-between gap-2 px-2',
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5" aria-label="Quorum Backoffice">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center text-text-primary"
            aria-hidden="true"
          >
            <BrandMark size={30} />
          </span>
          {!compact && (
            <span className="flex min-w-0 flex-col leading-tight text-text-primary">
              <span className="text-xs font-bold uppercase tracking-[0.1em]">Quorum</span>
              <span className="text-[0.65rem] font-medium uppercase tracking-[0.08em]">
                Backoffice
              </span>
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setCompact((value) => !value)}
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center text-text-muted hover:bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
            compact
              ? 'absolute -right-4 top-3 z-10 rounded-full border border-border bg-card'
              : 'rounded-lg',
          )}
          aria-label={compact ? 'Expandir menú' : 'Contraer menú'}
          aria-expanded={!compact}
          data-testid="sidebar-collapse"
        >
          {compact ? (
            <ChevronsRight className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ChevronsLeft className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      </div>

      <NavigationLinks user={user} compact={compact} />
      <div
        className="shrink-0 border-t border-border px-1 pt-3 pb-2"
        data-testid="sidebar-footer"
      >
        <LogoutButton compact={compact} />
      </div>
    </aside>
  );
}
