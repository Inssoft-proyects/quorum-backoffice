import { render, screen } from '@testing-library/react';
import {
  DashboardPageClient,
  type DashboardData,
} from '@/app/(authed)/dashboard/_components/dashboard-page-client';
import type {
  AuditEntry,
  DispositivoDetailResponse,
  MarbeteDetailResponse,
} from '@quorum-backoffice/shared';

/**
 * The dashboard rebuilds the 4-metric-card layout per the marbetes
 * maquette (Total / Disponibles / Asignados / Por atender). On the
 * dashboard the 4 cards are Marbetes / Dispositivos / Auditoría /
 * Por atender, all fed by defensive server-side fetches.
 *
 * The fixtures below are intentionally minimal — only the fields the
 * component reads are populated.
 */
function makeMarbete(
  id: number,
  overrides: Partial<MarbeteDetailResponse> = {},
): MarbeteDetailResponse {
  return {
    id,
    publicUid: `m-${id.toString().padStart(4, '0')}`,
    maskedCode: '1***23',
    status: 'active',
    assignedStudentId: null,
    assignedAt: null,
    createdAt: new Date().toISOString(),
    createdBy: 'tester',
    deletedAt: null,
    deletionReason: null,
    student: null,
    ...overrides,
  };
}

function makeDispositivo(
  id: number,
  overrides: Partial<DispositivoDetailResponse> = {},
): DispositivoDetailResponse {
  return {
    id,
    serialNumber: `SN-${id.toString().padStart(4, '0')}`,
    brand: null,
    model: null,
    status: 'active',
    createdAt: new Date().toISOString(),
    createdBy: 'tester',
    revokedAt: null,
    revokedReason: null,
    ...overrides,
  };
}

function makeAudit(
  id: number,
  overrides: Partial<AuditEntry> = {},
): AuditEntry {
  return {
    id,
    occurredAt: new Date().toISOString(),
    actorId: 'tester@quorum.local',
    actorEmail: 'tester@quorum.local',
    action: 'marbete.create',
    entityType: 'marbete',
    entityId: `m-${id.toString().padStart(4, '0')}`,
    beforeJson: null,
    afterJson: { id },
    otpId: null,
    ip: '127.0.0.1',
    userAgent: 'jest',
    ...overrides,
  };
}

const SUCCESS_DATA: DashboardData = {
  marbetes: {
    total: 248,
    items: [
      makeMarbete(1, { status: 'active', assignedStudentId: null }),
      makeMarbete(2, { status: 'active', assignedStudentId: 42 }),
    ],
    error: false,
  },
  dispositivos: {
    total: 12,
    items: [makeDispositivo(1, { brand: 'Apple' })],
    error: false,
  },
  audit: {
    total: 7,
    items: [makeAudit(1)],
    error: false,
  },
  user: { email: 'admin@quorum.local', role: 'admin' },
};

describe('DashboardPageClient (maquette v2)', () => {
  it('T1: renders the inventory header + 4 metric cards (Marbetes / Dispositivos / Auditoría / Por atender)', () => {
    render(<DashboardPageClient data={SUCCESS_DATA} />);
    expect(screen.getByRole('heading', { name: 'Inicio' })).toBeInTheDocument();
    // 4 metric cards, identified by their stable testid.
    expect(screen.getByTestId('dashboard-card-marbetes')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-card-dispositivos')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-card-audit')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-card-attention')).toBeInTheDocument();
    // Metric labels live inside .metric-card__label spans; use scoped
    // queries to avoid false positives on the page copy.
    expect(screen.getByTestId('dashboard-card-marbetes')).toHaveTextContent('Marbetes');
    expect(screen.getByTestId('dashboard-card-dispositivos')).toHaveTextContent('Dispositivos');
    expect(screen.getByTestId('dashboard-card-audit')).toHaveTextContent('Auditoría');
    expect(screen.getByTestId('dashboard-card-attention')).toHaveTextContent('Por atender');
  });

  it('T2: each domain card shows the API total when the fetch succeeded', () => {
    render(<DashboardPageClient data={SUCCESS_DATA} />);
    expect(screen.getByTestId('dashboard-card-marbetes')).toHaveTextContent('248');
    expect(screen.getByTestId('dashboard-card-dispositivos')).toHaveTextContent('12');
    expect(screen.getByTestId('dashboard-card-audit')).toHaveTextContent('7');
  });

  it('T3: failed endpoint renders a neutral card (em-dash + "Sin acceso") without crashing the page', () => {
    const partial: DashboardData = {
      marbetes: { total: 0, items: [], error: true },
      dispositivos: { total: 0, items: [], error: true },
      audit: { total: 5, items: [makeAudit(1)], error: false },
      user: { email: 'auditor@quorum.local', role: 'auditor' },
    };
    render(<DashboardPageClient data={partial} />);
    // Marbetes + dispositivos failed → render the neutral state.
    expect(screen.getByTestId('dashboard-card-marbetes')).toHaveTextContent('—');
    expect(screen.getByTestId('dashboard-card-marbetes')).toHaveTextContent('Sin acceso');
    expect(screen.getByTestId('dashboard-card-dispositivos')).toHaveTextContent('Sin acceso');
    // Audit still shows the live total.
    expect(screen.getByTestId('dashboard-card-audit')).toHaveTextContent('5');
    // Por-atender card stays rendered (its total is 0 → "Sin pendientes" + "0% del total").
    expect(screen.getByTestId('dashboard-card-attention')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-card-attention')).toHaveTextContent('Sin pendientes');
  });

  it('T4: the Por-atender card aggregates marbetes attention + dispositivos sin marca + audit.failed', () => {
    // 1 marbete already expired (10 years ago), 1 dispositivo sin marca,
    // 1 audit auth.failed → 3 pills.
    const longAgo = new Date(Date.now() - 1000 * 60 * 60 * 24 * 365 * 10).toISOString();
    const partial: DashboardData = {
      marbetes: {
        total: 1,
        items: [makeMarbete(1, { createdAt: longAgo, status: 'active' })],
        error: false,
      },
      dispositivos: {
        total: 1,
        items: [makeDispositivo(1, { brand: null })],
        error: false,
      },
      audit: {
        total: 1,
        items: [makeAudit(1, { action: 'auth.failed' })],
        error: false,
      },
      user: { email: 'admin@quorum.local', role: 'admin' },
    };
    render(<DashboardPageClient data={partial} />);
    const attention = screen.getByTestId('dashboard-card-attention');
    expect(attention).toHaveTextContent('1 marbetes vencidos');
    expect(attention).toHaveTextContent('1 disp. sin marca');
    expect(attention).toHaveTextContent('1 login fallido');
  });
});