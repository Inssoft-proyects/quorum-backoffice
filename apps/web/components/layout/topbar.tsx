import type { MeResponse } from '@quorum-backoffice/shared';
import { Badge } from '@/components/ui/badge';
import { LogoutButton } from './logout-button';

/**
 * Topbar: user email, role badge, logout button. Server component; the
 * logout action is delegated to a client wrapper (LogoutButton) that
 * drives AuthContext + navigation.
 */
export function Topbar({ user }: { user: MeResponse }) {
  return (
    <header className="flex h-14 items-center justify-between border-b border-border bg-card px-6">
      <div className="text-sm text-text-muted">{user.email}</div>
      <div className="flex items-center gap-3">
        <Badge variant="outline" className="uppercase">{user.role}</Badge>
        <LogoutButton />
      </div>
    </header>
  );
}