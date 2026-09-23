import { redirect } from 'next/navigation';
import { getServerSession } from '@/lib/server-session';
import { AuthProvider } from '@/lib/auth-context';
import { LoginForm } from './login-form';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Icon } from '@/components/icons';

/**
 * Login page (server component).
 *
 * If the caller already has a valid session cookie, redirect to /dashboard.
 * Otherwise render the login form wrapped in AuthProvider so the client form
 * can drive the API + state. Replaces the WU1b design-system placeholder.
 */
export default async function LoginPage() {
  const user = await getServerSession();
  if (user) redirect('/dashboard');

  return (
    <AuthProvider initialUser={null}>
      <main className="flex min-h-screen items-center justify-center bg-muted px-4 py-12">
        <Card className="w-full max-w-md">
          <CardHeader>
            <header className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-md bg-primary-500 text-white">
                <Icon name="id-card" variant="inherit" size={22} aria-label="InecConecta" />
              </span>
              <div>
                <CardTitle className="text-text-primary">InecConecta · Backoffice</CardTitle>
                <CardDescription>Acceso administrativo</CardDescription>
              </div>
            </header>
          </CardHeader>
          <CardContent>
            <LoginForm />
          </CardContent>
        </Card>
      </main>
    </AuthProvider>
  );
}