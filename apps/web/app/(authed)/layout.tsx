import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { getServerSession } from '@/lib/server-session';
import { AuthProvider } from '@/lib/auth-context';
import { AppShell } from '@/components/layout/app-shell';

/**
 * (authed) route group layout.
 *
 * Resolves the session server-side; if no user, redirects to /login.
 * Otherwise wraps the page in AuthProvider (seeded with the resolved user)
 * and the AppShell chrome.
 */
export default async function AuthedLayout({ children }: { children: ReactNode }) {
  const user = await getServerSession();
  if (!user) redirect('/login');
  return (
    <AuthProvider initialUser={user}>
      <AppShell user={user}>{children}</AppShell>
    </AuthProvider>
  );
}