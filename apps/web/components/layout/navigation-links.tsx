'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ClipboardList, House, Link2, Monitor, Package, type LucideIcon } from 'lucide-react';
import type { MeResponse } from '@quorum-backoffice/shared';
import { hasAtLeastRole } from '@quorum-backoffice/shared';
import { cn } from '@/lib/utils';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  auditorOnly?: boolean;
}

interface NavGroup {
  label?: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  { items: [{ href: '/dashboard', label: 'Inicio', icon: House }] },
  {
    label: 'Inventario',
    items: [
      { href: '/marbetes', label: 'Marbetes', icon: Package },
      { href: '/dispositivos', label: 'Dispositivos', icon: Monitor },
    ],
  },
  {
    label: 'Operaciones',
    items: [{ href: '/asociar', label: 'Asignación de marbetes', icon: Link2 }],
  },
  {
    label: 'Control',
    items: [{ href: '/audit', label: 'Auditoría', icon: ClipboardList, auditorOnly: true }],
  },
];

export function NavigationLinks({
  user,
  compact = false,
  onNavigate,
  testIdPrefix,
}: {
  user: MeResponse;
  compact?: boolean;
  onNavigate?: () => void;
  testIdPrefix?: string;
}) {
  const pathname = (usePathname() ?? '').replace(/^\/backoffice(?=\/|$)/, '') || '/';
  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.auditorOnly || hasAtLeastRole(user.role, 'auditor')),
  })).filter((group) => group.items.length > 0);

  return (
    <nav
      aria-label="Navegación principal"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-4"
    >
      {groups.map((group, index) => (
        <div
          key={group.label ?? 'inicio'}
          className={cn(index > 0 && (compact ? 'mt-3 border-t border-border pt-3' : 'mt-2'))}
          role={group.label ? 'group' : undefined}
          aria-label={group.label}
        >
          {group.label && !compact ? (
            <p className="mb-1 px-3 text-sm font-medium text-text-muted">{group.label}</p>
          ) : null}
          <div className="flex flex-col gap-1">
            {group.items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              const ItemIcon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={active ? 'page' : undefined}
                  aria-label={compact ? item.label : undefined}
                  title={compact ? item.label : undefined}
                  data-testid={testIdPrefix ? `${testIdPrefix}-${item.href.slice(1)}` : undefined}
                  className={cn(
                    'app-nav-link flex min-h-10 items-center gap-3 rounded-xl px-3 py-2 text-[0.92rem] leading-snug transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                    compact && 'justify-center px-2',
                  )}
                >
                  <ItemIcon className="h-5 w-5 shrink-0" strokeWidth={1.8} aria-hidden="true" />
                  {!compact ? <span>{item.label}</span> : null}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
