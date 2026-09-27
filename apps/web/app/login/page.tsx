import { redirect } from 'next/navigation';
import { getServerSession } from '@/lib/server-session';
import { AuthProvider } from '@/lib/auth-context';
import { LoginFormOtp } from './login-form-otp';
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
 * Polish WU v6 / A7: the form now drives the email + OTP flow. If the
 * caller already has a valid session cookie, redirect to /dashboard.
 * Otherwise render the form wrapped in AuthProvider so the client form
 * can drive the API + state.
 *
 * Layout follows `diseno/design/OPT_Dinamico.png`: centered gold icon
 * chip, centered title + description, gold-accented OTP zone (rendered
 * by the client form). The session-redirect + AuthProvider wiring stay
 * untouched — only the visible chrome changes.
 */
export default async function LoginPage() {
  const user = await getServerSession();
  if (user) redirect('/dashboard');

  return (
    <AuthProvider initialUser={null}>
      <main className="flex min-h-screen items-center justify-center bg-muted px-4 py-12">
        <Card className="w-full max-w-md shadow-md">
          <CardHeader className="items-center gap-3 pb-2 text-center">
            <header className="flex w-full flex-col items-center gap-3 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-500 text-white shadow-sm">
                <Icon name="id-card" variant="inherit" size={24} aria-label="InecConecta" />
              </span>
              <div className="space-y-1">
                <CardTitle className="text-text-primary">InecConecta · Backoffice</CardTitle>
                <CardDescription className="text-text-muted">
                  Acceso administrativo
                </CardDescription>
              </div>
            </header>
          </CardHeader>
          <CardContent className="pt-2">
            <LoginFormOtp />
          </CardContent>
        </Card>
      </main>
    </AuthProvider>
  );
}