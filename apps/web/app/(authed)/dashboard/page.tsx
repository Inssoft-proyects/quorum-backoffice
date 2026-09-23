import { getServerSession } from '@/lib/server-session';
import { redirect } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Dashboard landing page. Defensive session check (the parent (authed)
 * layout already enforces this, but we read the user here to render a
 * welcome heading).
 */
export default async function DashboardPage() {
  const user = await getServerSession();
  if (!user) redirect('/login');
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold text-text-primary">
        Bienvenido, {user.email}
      </h1>
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader><CardTitle className="text-sm">Marbetes</CardTitle></CardHeader>
          <CardContent>Gestión de marbetes QR (próximamente en WU8)</CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Dispositivos</CardTitle></CardHeader>
          <CardContent>Dispositivos autorizados (próximamente en WU9)</CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Auditoría</CardTitle></CardHeader>
          <CardContent>Registro de cambios (próximamente en WU10)</CardContent>
        </Card>
      </div>
    </div>
  );
}