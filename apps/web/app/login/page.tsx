import { redirect } from 'next/navigation';
import Image from 'next/image';
import { getServerSession } from '@/lib/server-session';
import { AuthProvider } from '@/lib/auth-context';
import { LoginFormOtp } from './login-form-otp';
import { BrandMark } from '@/components/layout/brand-mark';
import laptopMockup from '../../public/assets/login-laptop-full-app.png';

/**
 * Login page (server component).
 *
 * The form drives the username + OTP flow. If the
 * caller already has a valid session cookie, redirect to /dashboard.
 * Otherwise render the form wrapped in AuthProvider so the client form
 * can drive the API + state.
 *
 * The split layout presents the existing login form beside a laptop mockup
 * showing the local sample inventory. Authentication remains in LoginFormOtp.
 */
export default async function LoginPage() {
  const user = await getServerSession();
  if (user) redirect('/dashboard');

  return (
    <AuthProvider initialUser={null}>
      <main className="login-page">
        <section className="login-page__form-pane" aria-labelledby="login-heading">
          <div className="login-page__content">
            <header className="login-page__header">
              <span className="login-page__brand-mark">
                <BrandMark size={28} aria-label="InecConecta" />
              </span>
              <h1 id="login-heading" className="login-page__title">
                InecConecta · Backoffice
              </h1>
              <p className="login-page__description">Acceso administrativo</p>
            </header>
            <LoginFormOtp />
          </div>
        </section>
        <aside className="login-page__visual" aria-label="Vista previa del inventario de Quorum">
          <div className="login-page__preview">
            <Image
              src={laptopMockup}
              alt="Laptop en ángulo con el menú lateral y el inventario de marbetes de Quorum"
              className="login-page__preview-image"
              unoptimized
            />
          </div>
        </aside>
      </main>
    </AuthProvider>
  );
}
