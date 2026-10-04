import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Icon } from '@/components/icons';
import { MfaForm } from './mfa-form';

/**
 * M2 — `/mfa` page (server component).
 *
 * The federated Canvas/Jitsi access flow sends the student here
 * when no MFA session is present:
 *
 *   GET https://backoffice.quorum.asistentepro.mx/backoffice/mfa?next=<encoded>
 *
 * This server component reads `searchParams.next` and forwards the
 * value to the client `MfaForm`. After a successful
 * `POST /api/v1/mfa/authenticate` the form navigates to `next`
 * (defaulting to `/dashboard`, which resolves to
 * `/backoffice/dashboard` under the configured basePath).
 *
 * The page is intentionally NOT wrapped in `AuthProvider` or the
 * `(authed)` layout: the MFA session cookie (`__Host-mfa_sid`)
 * is a different session kind than the operator session
 * (`__Host-sid`), and gating the page on the operator session
 * would lock out students who are mid-flow. The MFA endpoint
 * sets the cookie as a side effect; this page just renders the
 * form.
 *
 * Lookfeel mirrors `/login` (centered gold icon chip, centered
 * title + description, gold-accented OTP zone). Title is in
 * Spanish to match the rest of the operator surface.
 */
export default async function MfaPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  const next = typeof params.next === 'string' && params.next.length > 0 ? params.next : undefined;

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted px-4 py-12">
      <Card className="w-full max-w-md shadow-md">
        <CardHeader className="items-center gap-3 pb-2 text-center">
          <header className="flex w-full flex-col items-center gap-3 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-500 text-white shadow-sm">
              <Icon name="id-card" variant="inherit" size={24} aria-label="Acceso seguro" />
            </span>
            <div className="space-y-1">
              <CardTitle className="text-text-primary">Acceso seguro</CardTitle>
              <CardDescription className="text-text-muted">
                Ingresa tu marbete, número de serie y código dinámico
              </CardDescription>
            </div>
          </header>
        </CardHeader>
        <CardContent className="pt-2">
          <MfaForm next={next} />
        </CardContent>
      </Card>
    </main>
  );
}
