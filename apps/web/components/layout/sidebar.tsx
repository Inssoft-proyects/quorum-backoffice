'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  IdCard,
  LayoutDashboard,
  Link2,
  MonitorSmartphone,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  type LucideIcon,
} from 'lucide-react';
import type { MeResponse } from '@quorum-backoffice/shared';
import { hasAtLeastRole } from '@quorum-backoffice/shared';
import { cn } from '@/lib/utils';

interface NavItem {
  href: string;
  label: string;
  visible: boolean;
  Icon: LucideIcon;
}

export interface SidebarProps {
  user: MeResponse;
  className?: string;
  /**
   * Rail mode: the brand title and the nav labels move to `sr-only` and every
   * item collapses to its icon. The `title` attribute keeps the mouse tooltip,
   * and `sr-only` keeps the accessible name, so nothing is lost when the
   * painted width shrinks to 4.5rem.
   */
  collapsed?: boolean;
  /** Renders the collapse/expand control when provided (see `AppShell`). */
  onToggle?: () => void;
}

/**
 * Sidebar nav. Marbetes + Dispositivos are visible to all roles;
 * Auditoría is visible only to auditor+.
 *
 * The brand row carries the INEC Conecta mark, the `BackOffice` title and the
 * collapse toggle (`odd/tasks/backoffice-ui-canon.md`, S3/S4). The active route
 * keeps `aria-current="page"` and the same visual language the interior.dev
 * components use elsewhere: 8px radius, 13px medium label, primary-500 tint
 * and a 2px leading indicator.
 */
export function Sidebar({ user, className, collapsed = false, onToggle }: SidebarProps) {
  const pathname = usePathname();
  const items: NavItem[] = [
    { href: '/dashboard', label: 'Inicio', visible: true, Icon: LayoutDashboard },
    { href: '/marbetes', label: 'Marbetes', visible: true, Icon: IdCard },
    { href: '/asociar', label: 'Asignación de marbetes', visible: true, Icon: Link2 },
    { href: '/dispositivos', label: 'Dispositivos', visible: true, Icon: MonitorSmartphone },
    {
      href: '/audit',
      label: 'Auditoría',
      visible: hasAtLeastRole(user.role, 'auditor'),
      Icon: ScrollText,
    },
  ];

  return (
    <aside
      id="app-sidebar"
      className={cn(
        'flex flex-col border-r border-border bg-card',
        collapsed ? 'px-2 py-6' : 'px-4 py-6',
        className,
      )}
    >
      <div
        className={cn(
          'flex gap-2 pb-6',
          collapsed ? 'flex-col items-center' : 'items-center justify-between',
        )}
      >
        <div className={cn('flex items-center gap-2', collapsed && 'justify-center')}>
          {/* The mark is a static file under `public/assets`. `next/image`
           * cannot be used here: with `output: 'standalone'` + `basePath:
           * '/backoffice'` its optimizer (and even its `unoptimized` mode)
           * emits a path without the prefix and the file 404s. The bulk-upload
           * template already links its public asset with the explicit
           * `/backoffice/assets/...` form, so this follows that convention. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/backoffice/assets/inec-conecta.png"
            alt="INEC Conecta"
            width={28}
            height={28}
            className="h-7 w-7 shrink-0"
          />
          <span
            className={cn(
              'text-[15px] font-semibold tracking-tight text-text-primary',
              collapsed && 'sr-only',
            )}
          >
            BackOffice
          </span>
        </div>
        {onToggle ? (
          <button
            type="button"
            data-testid="sidebar-toggle"
            aria-expanded={!collapsed}
            aria-controls="app-sidebar"
            aria-label={collapsed ? 'Expandir barra lateral' : 'Contraer barra lateral'}
            onClick={onToggle}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {collapsed ? (
              <PanelLeftOpen className="h-4 w-4" aria-hidden />
            ) : (
              <PanelLeftClose className="h-4 w-4" aria-hidden />
            )}
          </button>
        ) : null}
      </div>
      <nav
        className={cn('flex flex-col gap-1', collapsed && 'items-center')}
        aria-label="Navegación principal"
      >
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
                title={collapsed ? item.label : undefined}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative flex items-center rounded-md text-[13px] transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  collapsed ? 'h-9 w-9 justify-center' : 'gap-2.5 px-3 py-2',
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
                <item.Icon className="h-4 w-4 shrink-0" aria-hidden />
                <span className={collapsed ? 'sr-only' : undefined}>{item.label}</span>
              </Link>
            );
          })}
      </nav>
    </aside>
  );
}
