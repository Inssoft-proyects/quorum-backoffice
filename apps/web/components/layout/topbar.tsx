import type { MeResponse } from '@quorum-backoffice/shared';
import { CircleUserRound } from 'lucide-react';
import { MobileNav } from './mobile-nav';

/**
 * Topbar: drawer trigger below 1024px and account identity aligned to the right.
 */
export function Topbar({ user }: { user: MeResponse }) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-card px-4 sm:px-6 lg:px-8">
      <div className="flex items-center lg:hidden">
        <MobileNav user={user} />
      </div>
      <div className="ml-auto flex min-w-0 items-center gap-5 sm:gap-8" aria-label="Cuenta actual">
        <span className="hidden truncate text-sm font-semibold text-text-primary sm:inline">
          {user.email}
        </span>
        <CircleUserRound
          className="h-9 w-9 shrink-0 text-text-muted-bold"
          strokeWidth={2.2}
          aria-label={`Perfil de ${user.email}`}
          role="img"
        />
      </div>
    </header>
  );
}
