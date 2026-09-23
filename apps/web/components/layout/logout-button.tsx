'use client';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth-context';

/**
 * Client logout button. Calls AuthContext.logout (POST /api/v1/auth/logout
 * + clear local user) and navigates back to /login.
 */
export function LogoutButton() {
  const router = useRouter();
  const { logout } = useAuth();
  const [isPending, startTransition] = useTransition();
  async function handleClick() {
    await logout();
    startTransition(() => router.push('/login'));
  }
  return (
    <Button variant="outline" size="sm" onClick={handleClick} disabled={isPending}>
      {isPending ? 'Saliendo…' : 'Salir'}
    </Button>
  );
}