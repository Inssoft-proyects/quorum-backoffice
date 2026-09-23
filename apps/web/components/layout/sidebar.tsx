import Link from 'next/link';
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
 */
export function Sidebar({
  user,
  className,
}: {
  user: MeResponse;
  className?: string;
}) {
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
    <aside
      className={cn(
        'flex flex-col border-r border-border bg-card px-4 py-6',
        className,
      )}
    >
      <div className="px-2 pb-6 text-sm font-semibold uppercase tracking-wider text-text-muted">
        Quorum Backoffice
      </div>
      <nav className="flex flex-col gap-1" aria-label="Navegación principal">
        {items
          .filter((i) => i.visible)
          .map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'rounded-md px-3 py-2 text-sm text-text-primary transition-colors',
                'hover:bg-muted hover:text-primary-500',
              )}
            >
              {item.label}
            </Link>
          ))}
      </nav>
    </aside>
  );
}