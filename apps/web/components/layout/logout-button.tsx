'use client';
import { LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/utils';

/**
 * Client logout button. Calls AuthContext.logout (POST /api/v1/auth/logout
 * + clear local user) and navigates back to /login.
 */
export function LogoutButton({
  compact = false,
  onLoggedOut,
}: {
  compact?: boolean;
  onLoggedOut?: () => void;
}) {
  const router = useRouter();
  const { logout } = useAuth();
  const [isPending, startTransition] = useTransition();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const busy = isLoggingOut || isPending;
  async function handleClick() {
    if (busy) return;
    setIsLoggingOut(true);
    try {
      await logout();
      onLoggedOut?.();
      startTransition(() => router.push('/login'));
    } finally {
      setIsLoggingOut(false);
    }
  }
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={handleClick}
      disabled={busy}
      aria-label={compact ? (busy ? 'Saliendo…' : 'Salir') : undefined}
      aria-busy={busy}
      title={compact ? 'Salir' : undefined}
      className={cn(
        'w-full justify-center gap-3 bg-[var(--color-page)] text-center text-text-primary hover:bg-muted focus-visible:ring-focus focus-visible:ring-offset-0',
        compact && 'px-0',
      )}
    >
      <LogOut className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className={compact ? 'sr-only' : undefined}>
        {busy ? 'Saliendo…' : 'Salir'}
      </span>
    </Button>
  );
}
