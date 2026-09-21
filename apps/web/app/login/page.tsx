import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Icon } from '@/components/icons';

/**
 * WU1b demo login form. Uses the InecConecta design tokens and shadcn
 * components wired in WU1a. WU7 replaces this with the real auth flow
 * (form submit + API client + session cookie + redirect).
 */
export default function LoginPagePlaceholder() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted px-4 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-md bg-primary-500 text-white">
              <Icon name="id-card" variant="inherit" size={22} aria-label="InecConecta" />
            </span>
            <div>
              <CardTitle className="text-text-primary">InecConecta · Backoffice</CardTitle>
              <CardDescription>
                Acceso administrativo · WU7 implementa el flujo real.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" aria-disabled>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Correo</Label>
              <Input id="email" type="email" placeholder="admin@quorum.local" disabled />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">Contraseña</Label>
              <Input id="password" type="password" placeholder="••••••••" disabled />
            </div>
            <Button type="button" variant="default" disabled>
              <Icon name="check" variant="inherit" size={16} />
              Iniciar sesión
            </Button>
            <p className="text-xs text-muted-foreground">
              Esta pantalla es un demo del design system WU1b. La integración con
              <code className="mx-1 rounded bg-muted px-1 py-0.5">/api/v1/auth/login</code>
              llega en WU7. ¿Necesitas ayuda?{' '}
              <Link href="#" className="text-primary-500 underline-offset-4 hover:underline">
                Contacta al administrador
              </Link>
              .
            </p>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
