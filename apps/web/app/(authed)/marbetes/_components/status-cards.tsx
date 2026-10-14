import type { MarbeteCountersResponse } from '@quorum-backoffice/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Two-up status cards for the Marbetes page (OK vs KO counters).
 * Server component — receives pre-fetched counters from the page.
 */
export function StatusCards({ counters }: { counters: MarbeteCountersResponse }) {
  return (
    <div className="grid gap-4 md:grid-cols-2" data-testid="status-cards">
      <Card data-testid="status-card-ok">
        <CardHeader>
          <CardTitle className="text-sm text-text-muted">Marbetes OK</CardTitle>
        </CardHeader>
        <CardContent>
          <div
            className="text-3xl font-semibold text-feedback-success"
            data-testid="counter-ok"
          >
            {counters.ok}
          </div>
          <p className="mt-1 text-xs text-text-muted">Activos y asignados a un estudiante</p>
        </CardContent>
      </Card>
      <Card data-testid="status-card-ko">
        <CardHeader>
          <CardTitle className="text-sm text-text-muted">Marbetes KO</CardTitle>
        </CardHeader>
        <CardContent>
          <div
            className="text-3xl font-semibold text-alert-error-text"
            data-testid="counter-ko"
          >
            {counters.ko}
          </div>
          <p className="mt-1 text-xs text-text-muted">Sin asignar, inactivos o eliminados</p>
        </CardContent>
      </Card>
    </div>
  );
}
