'use client';

import { useRef, useState } from 'react';
import { Menu } from 'lucide-react';
import type { MeResponse } from '@quorum-backoffice/shared';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { BrandMark } from './brand-mark';
import { NavigationLinks } from './navigation-links';
import { LogoutButton } from './logout-button';

/** Mobile drawer with the same routes and role rules as the desktop menu. */
export function MobileNav({ user }: { user: MeResponse }) {
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus lg:hidden"
        aria-label="Abrir menú"
        data-testid="mobile-nav-trigger"
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </button>
      <DialogContent
        ref={contentRef}
        aria-modal="true"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.querySelector<HTMLAnchorElement>('nav a[href]')?.focus();
        }}
        className="fixed inset-y-0 left-0 right-auto top-0 z-50 flex w-72 max-w-[85vw] translate-x-0 translate-y-0 flex-col gap-0 border-r border-border bg-card p-0 data-[state=closed]:duration-200 data-[state=open]:duration-200 data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:rounded-none"
      >
        <DialogTitle className="sr-only">Menú principal</DialogTitle>
        <div className="flex items-center gap-2.5 px-5 pb-5 pt-6 pr-12">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center text-text-primary"
            aria-hidden="true"
          >
            <BrandMark size={30} />
          </span>
          <span className="text-xs font-bold uppercase tracking-[0.1em] text-text-primary">
            Quorum Backoffice
          </span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col px-4">
          <NavigationLinks
            user={user}
            onNavigate={() => setOpen(false)}
            testIdPrefix="mobile-nav-link"
          />
        </div>
        <div
          className={cn(
            'shrink-0 border-t border-border px-4 pt-3',
            process.env.NODE_ENV === 'development'
              ? 'pb-[calc(2rem+env(safe-area-inset-bottom))]'
              : 'pb-[calc(1rem+env(safe-area-inset-bottom))]',
          )}
          data-testid="mobile-nav-footer"
        >
          <LogoutButton onLoggedOut={() => setOpen(false)} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
