'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { MeResponse } from '@quorum-backoffice/shared';
import { hasAtLeastRole } from '@quorum-backoffice/shared';
import { cn } from '@/lib/utils';

interface NavItem {
  href: string;
  label: string;
  visible: boolean;
}

/**
 * Sidebar nav. Marbetes + Dispositivos are visible to all roles;
 * Auditoría is visible only to auditor+.
 *
 * The active route is marked with `aria-current="page"` and the same visual
 * language the interior.dev components use elsewhere: 8px radius, 13px
 * medium label, primary-500 tint and a 2px leading indicator. Before this,
 * the only green label in the screenshots was the one under the pointing
 * device: navigation had no state at all.
 */
export function Sidebar({ user, className }: { user: MeResponse; className?: string }) {
  const pathname = usePathname();
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
    <aside className={cn('flex flex-col border-r border-border bg-card px-4 py-6', className)}>
      <div className="px-2 pb-6 text-[13px] font-medium uppercase tracking-[0.08em] text-text-muted">
        Quorum Backoffice
      </div>
      <nav className="flex flex-col gap-1" aria-label="Navegación principal">
        {items
          .filter((i) => i.visible)
          .map((item) => {
            const active = Boolean(
              pathname &&
              (pathname === item.href ||
                (item.href !== '/dashboard' && pathname.startsWith(`${item.href}/`))),
            );
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative rounded-md px-3 py-2 text-[13px] transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'bg-primary-500/10 font-medium text-primary-600'
                    : 'font-normal text-text-primary hover:bg-muted hover:text-primary-500',
                )}
              >
                {active ? (
                  <span
                    aria-hidden
                    className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-primary-500"
                  />
                ) : null}
                {item.label}
              </Link>
            );
          })}
      </nav>
    </aside>
  );
}
