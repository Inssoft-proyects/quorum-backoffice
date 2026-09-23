'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Menu } from 'lucide-react';
import type { MeResponse } from '@quorum-backoffice/shared';
import { hasAtLeastRole } from '@quorum-backoffice/shared';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

interface NavItem {
  href: string;
  label: string;
  visible: boolean;
}

/**
 * Mobile navigation drawer (RESP-001).
 *
 * Hamburger trigger visible only on viewports < 768px (Tailwind `md`
 * breakpoint). Tapping it opens a left-side Radix Dialog containing
 * the same nav items rendered by the desktop Sidebar, plus an X
 * (rendered by the shared DialogContent close button).
 *
 * The drawer uses two `data-state` transforms defined in globals.css
 * under `@layer components` (`slide-in-from-left` / `slide-out-to-left`)
 * so the panel animates in/out from the left edge without depending on
 * tailwindcss-animate.
 */
export function MobileNav({ user }: { user: MeResponse }) {
  const [open, setOpen] = useState(false);
  const items: NavItem[] = [
    { href: '/dashboard', label: 'Inicio', visible: true },
    { href: '/marbetes', label: 'Marbetes', visible: true },
    { href: '/dispositivos', label: 'Dispositivos', visible: true },
    {
      href: '/audit',
      label: 'Auditoría',
      visible: hasAtLeastRole(user.role, 'auditor'),
    },
  ];
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="md:hidden inline-flex h-9 w-9 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label="Abrir menú"
        data-testid="mobile-nav-trigger"
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </button>
      <DialogContent
        aria-modal="true"
        className="fixed inset-y-0 left-0 right-auto top-0 z-50 w-72 max-w-[85vw] translate-x-0 translate-y-0 gap-0 border-r border-border bg-card p-0 data-[state=closed]:duration-200 data-[state=open]:duration-200 data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:rounded-none"
      >
        <DialogTitle className="sr-only">Menú principal</DialogTitle>
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3 pr-12">
          <span className="text-sm font-semibold uppercase tracking-wider text-text-muted">
            Quorum Backoffice
          </span>
        </div>
        <nav className="flex flex-col gap-1 p-4" aria-label="Navegación principal">
          {items
            .filter((i) => i.visible)
            .map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className={cn(
                  'rounded-md px-3 py-2 text-sm text-text-primary transition-colors',
                  'hover:bg-muted hover:text-primary-500',
                )}
                data-testid={`mobile-nav-link-${item.href.replace('/', '')}`}
              >
                {item.label}
              </Link>
            ))}
        </nav>
      </DialogContent>
    </Dialog>
  );
}
