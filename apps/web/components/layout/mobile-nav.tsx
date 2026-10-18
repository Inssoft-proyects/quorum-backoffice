'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Menu } from 'lucide-react';
import type { MeResponse } from '@quorum-backoffice/shared';
import { hasAtLeastRole } from '@quorum-backoffice/shared';
import { Drawer } from '@/components/interior/drawer';
import { cn } from '@/lib/utils';

interface NavItem {
  href: string;
  label: string;
  visible: boolean;
}

/**
 * Mobile navigation as an interior.dev Drawer
 * (https://www.interior.dev/docs/drawer) instead of a Radix Dialog with
 * `data-state` CSS transforms.
 *
 * The equivalent guarantees: the panel enters from its own edge and can be
 * dragged back toward it (the drag position is the exit position, so the
 * gesture and the animation agree), the scrim fades under the finger, Escape
 * closes, focus is trapped and returned, and `prefers-reduced-motion` keeps
 * the panel reachable without the trip. The trigger and every link keep their
 * `data-testid`, and the audit link keeps its role gate.
 */
export function MobileNav({ user }: { user: MeResponse }) {
  const [open, setOpen] = useState(false);
  const items: NavItem[] = [
    { href: '/dashboard', label: 'Inicio', visible: true },
    { href: '/marbetes', label: 'Marbetes', visible: true },
    { href: '/asociar', label: 'Asignación de marbetes', visible: true },
    { href: '/dispositivos', label: 'Dispositivos', visible: true },
    {
      href: '/audit',
      label: 'Auditoría',
      visible: hasAtLeastRole(user.role, 'auditor'),
    },
  ];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="md:hidden inline-flex h-9 w-9 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label="Abrir menú"
        data-testid="mobile-nav-trigger"
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </button>

      <Drawer
        open={open}
        onOpenChange={setOpen}
        title="Menú principal"
        description="Quorum Backoffice"
        side="left"
        width={288}
        closeLabel="Cerrar menú"
      >
        <nav className="flex flex-col gap-1" aria-label="Navegación principal">
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
      </Drawer>
    </>
  );
}
