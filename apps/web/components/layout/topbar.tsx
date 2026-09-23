import type { MeResponse } from '@quorum-backoffice/shared';
import { Badge } from '@/components/ui/badge';
import { LogoutButton } from './logout-button';
import { MobileNav } from './mobile-nav';

/**
 * Topbar: mobile hamburger trigger (RESP-001), user email, role badge,
 * logout button. Server component. The hamburger is `md:hidden`; the
 * email is hidden on mobile to keep the topbar readable at 360px.
 */
export function Topbar({ user }: { user: MeResponse }) {
  return (
    <header className="flex h-14 items-center justify-between gap-2 border-b border-border bg-card px-4 md:px-6">
      <div className="flex items-center gap-2">
        <MobileNav user={user} />
        <span className="hidden text-sm text-text-muted md:inline">
          {user.email}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <Badge variant="outline" className="uppercase">{user.role}</Badge>
        <LogoutButton />
      </div>
    </header>
  );
}