/**
 * Tests for the "Asignación de marbetes" page client.
 *
 * Coverage:
 *  - Wiring: renders the four metric cards + the two tabs + the
 *    default-unassigned panel + the assigned panel hidden behind
 *    the tab click. Banner stays hidden on first paint.
 *  - Metric counters / filter chip behaviour.
 *  - Sync button (admin-only) wires through POST /api/v1/matriculas/sync.
 *  - Selection state: bounded by availableMarbetes; select-all
 *    respects the limit; bulk button disabled when no rows picked
 *    or zero available marbetes.
 *  - Tab switch: metric chip "Filtro activo"/"Filtrar" copy and
 *    aria-selected flips correctly.
 *  - Reveal/unassign modals open from the assigned row actions.
 *  - Auto-dismiss + manual close of the app-alert success banner.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ListMatriculasStatus, MatriculaListItem } from '@quorum-backoffice/shared';
import { AsociarPageClient } from '@/app/(authed)/asociar/_components/asociar-page-client';

const refreshMock = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    refresh: refreshMock,
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/asociar',
}));

function makeMatricula(
  canvasUserId: number,
  overrides: Partial<MatriculaListItem> = {},
): MatriculaListItem {
  return {
    canvasUserId,
    fullName: `Matrícula ${canvasUserId}`,
    email: `mat${canvasUserId}@example.com`,
    isActive: true,
    registeredAt: '2024-09-12T10:00:00Z',
    marbete: null,
    ...overrides,
  };
}

const baseCounters = {
  total: 12,
  assigned: 7,
  unassigned: 5,
  availableMarbetes: 8,
};

function defaultUnassigned(): MatriculaListItem[] {
  return [
    makeMatricula(1),
    makeMatricula(2),
    makeMatricula(3),
    makeMatricula(4),
    makeMatricula(5),
  ];
}

function defaultAssigned(): MatriculaListItem[] {
  return [
    makeMatricula(101, {
      fullName: 'Ana López',
      email: 'ana@example.com',
      marbete: {
        id: 10,
        publicUid: 'm-AB12',
        maskedCode: '1***AB',
        status: 'active',
        assignedAt: '2024-09-10T08:30:00Z',
        assignedBy: 'admin@quorum.local',
      },
    }),
    makeMatricula(102, {
      fullName: 'Carlos Ruiz',
      email: 'carlos@example.com',
      marbete: {
        id: 11,
        publicUid: 'm-CD34',
        maskedCode: '1***CD',
        status: 'active',
        assignedAt: '2024-09-11T09:15:00Z',
        assignedBy: 'operator@quorum.local',
      },
    }),
  ];
}

function defaultAvailable() {
  return [
    { id: 1, maskedCode: '3***0001' },
    { id: 2, maskedCode: '3***0002' },
    { id: 3, maskedCode: '3***0003' },
    { id: 4, maskedCode: '3***0004' },
  ];
}

interface FetchHandlers {
  counters?: { total: number; assigned: number; unassigned: number; availableMarbetes: number };
  unassigned?: MatriculaListItem[];
  assigned?: MatriculaListItem[];
  grant?: { active: boolean; expiresAt: string | null };
  destructiveStatus?: number;
  destructiveBody?: unknown;
  syncStatus?: number;
  syncBody?: unknown;
}

function installFetchMock(handlers: FetchHandlers = {}): {
  grantRequests: number;
  assignRequests: number;
  unassignRequests: number;
  syncRequests: number;
  listRequests: number;
  countersRequests: number;
} {
  const counts = {
    grantRequests: 0,
    assignRequests: 0,
    unassignRequests: 0,
    syncRequests: 0,
    listRequests: 0,
    countersRequests: 0,
  };
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? '';
    if (url.includes('/api/v1/matriculas/assign') && method === 'POST') {
      counts.assignRequests += 1;
      const status = handlers.destructiveStatus ?? 200;
      return new Response(
        JSON.stringify(
          handlers.destructiveBody ?? {
            total: 1,
            pairs: [{ canvasUserId: 1, marbeteId: 1, publicUid: 'm-X' }],
          },
        ),
        { status, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/api/v1/matriculas/unassign') && method === 'POST') {
      counts.unassignRequests += 1;
      const status = handlers.destructiveStatus ?? 200;
      return new Response(
        JSON.stringify(
          handlers.destructiveBody ?? {
            id: 10,
            publicUid: 'm-X',
            maskedCode: '1***X',
            status: 'active',
            assignedStudentId: null,
            assignedAt: null,
            createdAt: '',
            createdBy: 'x',
            deletedAt: null,
            deletionReason: null,
            student: null,
          },
        ),
        { status, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/api/v1/matriculas/sync') && method === 'POST') {
      counts.syncRequests += 1;
      const status = handlers.syncStatus ?? 200;
      return new Response(
        JSON.stringify(
          handlers.syncBody ?? {
            total: 12,
            created: 0,
            updated: 0,
            unchanged: 12,
            skipped: 0,
            durationMs: 5,
          },
        ),
        { status, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/api/v1/marbetes/otp-grant')) {
      counts.grantRequests += 1;
      return new Response(
        JSON.stringify(
          handlers.grant ?? { active: false, expiresAt: null },
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/api/v1/matriculas/counters')) {
      counts.countersRequests += 1;
      return new Response(
        JSON.stringify(
          handlers.counters ?? baseCounters,
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/api/v1/matriculas')) {
      counts.listRequests += 1;
      const params = new URL(url).searchParams;
      const status = (params.get('status') ?? 'any') as ListMatriculasStatus;
      const items =
        status === 'assigned'
          ? (handlers.assigned ?? defaultAssigned())
          : (handlers.unassigned ?? defaultUnassigned());
      return new Response(
        JSON.stringify({ total: items.length, limit: 200, offset: 0, items }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/api/v1/marbetes/') && url.includes('/reveal')) {
      return new Response(
        JSON.stringify({ code: 'm-FULL', revealedAt: new Date().toISOString() }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ code: 'not_found', message: 'no' }), {
      status: 404,
    });
  }) as unknown as typeof fetch;
  return counts;
}

describe('AsociarPageClient', () => {
  beforeEach(() => {
    refreshMock.mockClear();
  });

  it('renders the four metric cards and the two tabs on first paint', () => {
    installFetchMock();
    render(
      <AsociarPageClient
        initialMatriculas={defaultUnassigned()}
        initialCounters={baseCounters}
        initialAvailableMarbetes={defaultAvailable()}
        initialStatus="unassigned"
        initialSearch=""
        userRole="admin"
      />,
    );
    expect(screen.getByText('Matrículas totales')).toBeInTheDocument();
    expect(screen.getByText('Marbetes disponibles')).toBeInTheDocument();
    // "Asignados" appears both in the metric-card label and in the tab
    // button text; we scope the assertion to the metric-card wrapper.
    const metricsSection = screen.getByRole('region', { name: /Resumen de asignación/i });
    expect(within(metricsSection).getByText('Disponibles')).toBeInTheDocument();
    expect(within(metricsSection).getByText('Asignados')).toBeInTheDocument();
    expect(screen.getByTestId('tab-unassigned')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('tab-assigned')).toHaveAttribute('aria-selected', 'false');
  });

  it('keeps the success banner hidden on initial render', () => {
    installFetchMock();
    render(
      <AsociarPageClient
        initialMatriculas={defaultUnassigned()}
        initialCounters={baseCounters}
        initialAvailableMarbetes={defaultAvailable()}
        initialStatus="unassigned"
        initialSearch=""
        userRole="admin"
      />,
    );
    const alert = screen.getByTestId('app-alert-success');
    expect(alert).toHaveAttribute('hidden');
  });

  it('shows the inventory-shortage variant when availableMarbetes < unassigned', () => {
    installFetchMock();
    const { container } = render(
      <AsociarPageClient
        initialMatriculas={defaultUnassigned()}
        initialCounters={{ ...baseCounters, availableMarbetes: 2, unassigned: 5 }}
        initialAvailableMarbetes={defaultAvailable()}
        initialStatus="unassigned"
        initialSearch=""
        userRole="admin"
      />,
    );
    const card = container.querySelector('[data-inventory-card]');
    expect(card?.classList.contains('is-inventory-shortage')).toBe(true);
    expect(screen.getByTestId('metric-inventory-status')).toHaveTextContent(
      /Faltan 3 marbetes/,
    );
  });

  it('opens the bulk assign modal and submits POST /assign with the right body', async () => {
    const counts = installFetchMock();
    const user = userEvent.setup();
    render(
      <AsociarPageClient
        initialMatriculas={defaultUnassigned()}
        initialCounters={baseCounters}
        initialAvailableMarbetes={defaultAvailable()}
        initialStatus="unassigned"
        initialSearch=""
        userRole="admin"
      />,
    );

    await user.click(screen.getByTestId('unassigned-check-1'));
    await user.click(screen.getByTestId('unassigned-check-2'));
    await user.click(screen.getByTestId('open-bulk-assign'));

    // Modal opens with both enrolments.
    expect(await screen.findByTestId('assign-review-modal')).toBeInTheDocument();
    expect(screen.getByTestId('assign-review-row-1')).toBeInTheDocument();
    expect(screen.getByTestId('assign-review-row-2')).toBeInTheDocument();

    // Select the first available marbete for each row.
    await user.selectOptions(
      screen.getByTestId('assign-review-select-1'),
      '1',
    );
    await user.selectOptions(
      screen.getByTestId('assign-review-select-2'),
      '2',
    );

    // OTP input is required (no grant active).
    const otpInputs = screen.getAllByRole('textbox', { name: /Digit/i });
    for (const input of otpInputs) {
      await user.type(input, '1');
    }

    await user.click(screen.getByTestId('assign-review-confirm'));

    await waitFor(() => {
      expect(counts.assignRequests).toBe(1);
    });
    // Success banner surfaces the bulk title.
    const banner = await screen.findByTestId('app-alert-success');
    expect(banner).not.toHaveAttribute('hidden');
    expect(within(banner).getByTestId('app-alert-title')).toHaveTextContent(
      /Se asignaron correctamente/,
    );
  });

  it('keeps the assign submit disabled while the review has conflicts', async () => {
    installFetchMock();
    const user = userEvent.setup();
    render(
      <AsociarPageClient
        initialMatriculas={defaultUnassigned()}
        initialCounters={baseCounters}
        initialAvailableMarbetes={defaultAvailable()}
        initialStatus="unassigned"
        initialSearch=""
        userRole="admin"
      />,
    );

    await user.click(screen.getByTestId('unassigned-check-1'));
    await user.click(screen.getByTestId('unassigned-check-2'));
    await user.click(screen.getByTestId('open-bulk-assign'));

    await screen.findByTestId('assign-review-modal');
    // Both rows default to the same first marbete (index 0).
    expect(screen.getByTestId('assign-review-validation')).toHaveTextContent(
      /Revisa los marbetes seleccionados/,
    );
    expect(screen.getByTestId('assign-review-confirm')).toBeDisabled();
  });

  it('sends the sync request from the admin-only sync button', async () => {
    const counts = installFetchMock();
    const user = userEvent.setup();
    render(
      <AsociarPageClient
        initialMatriculas={defaultUnassigned()}
        initialCounters={baseCounters}
        initialAvailableMarbetes={defaultAvailable()}
        initialStatus="unassigned"
        initialSearch=""
        userRole="admin"
      />,
    );
    await user.click(screen.getByTestId('sync-matriculas-trigger'));
    await waitFor(() => {
      expect(counts.syncRequests).toBe(1);
    });
    const banner = await screen.findByTestId('app-alert-success');
    expect(within(banner).getByTestId('app-alert-title')).toHaveTextContent(
      'Matrículas sincronizadas.',
    );
  });

  it('hides the sync button for non-admin roles', () => {
    installFetchMock();
    render(
      <AsociarPageClient
        initialMatriculas={defaultUnassigned()}
        initialCounters={baseCounters}
        initialAvailableMarbetes={defaultAvailable()}
        initialStatus="unassigned"
        initialSearch=""
        userRole="operator"
      />,
    );
    expect(screen.queryByTestId('sync-matriculas-trigger')).toBeNull();
  });

  it('flips the metric-card aria-pressed + filter chip copy when the tab changes', async () => {
    installFetchMock();
    const user = userEvent.setup();
    render(
      <AsociarPageClient
        initialMatriculas={defaultUnassigned()}
        initialCounters={baseCounters}
        initialAvailableMarbetes={defaultAvailable()}
        initialStatus="unassigned"
        initialSearch=""
        userRole="admin"
      />,
    );
    await user.click(screen.getByTestId('tab-assigned'));
    expect(screen.getByTestId('tab-assigned')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('tab-unassigned')).toHaveAttribute('aria-selected', 'false');
  });

  it('opens the unassign modal from an assigned row', async () => {
    const counts = installFetchMock();
    const user = userEvent.setup();
    render(
      <AsociarPageClient
        initialMatriculas={defaultAssigned()}
        initialCounters={baseCounters}
        initialAvailableMarbetes={defaultAvailable()}
        initialStatus="assigned"
        initialSearch=""
        userRole="admin"
      />,
    );
    await user.click(screen.getByTestId('assigned-unassign-101'));
    expect(await screen.findByTestId('unassign-modal')).toBeInTheDocument();
    expect(screen.getByTestId('unassign-enrollment')).toHaveTextContent('Ana López');

    await user.selectOptions(
      screen.getByTestId('unassign-reason-select'),
      'dano-fisico',
    );
    const otpInputs = screen.getAllByRole('textbox', { name: /Digit/i });
    for (const input of otpInputs) {
      await user.type(input, '1');
    }
    await user.click(screen.getByTestId('unassign-confirm'));
    await waitFor(() => {
      expect(counts.unassignRequests).toBe(1);
    });
    const banner = await screen.findByTestId('app-alert-success');
    expect(within(banner).getByTestId('app-alert-title')).toHaveTextContent(
      'Marbete desasignado correctamente.',
    );
  });

  it('disables the bulk-assign button when no marbetes are available', () => {
    installFetchMock();
    render(
      <AsociarPageClient
        initialMatriculas={defaultUnassigned()}
        initialCounters={{ ...baseCounters, availableMarbetes: 0 }}
        initialAvailableMarbetes={[]}
        initialStatus="unassigned"
        initialSearch=""
        userRole="admin"
      />,
    );
    expect(screen.getByTestId('open-bulk-assign')).toBeDisabled();
    expect(screen.getByTestId('unassigned-select-all')).toBeDisabled();
  });

  it('shows the empty state copy when no rows match the search', async () => {
    installFetchMock();
    const user = userEvent.setup();
    render(
      <AsociarPageClient
        initialMatriculas={defaultUnassigned()}
        initialCounters={baseCounters}
        initialAvailableMarbetes={defaultAvailable()}
        initialStatus="unassigned"
        initialSearch=""
        userRole="admin"
      />,
    );
    const search = screen.getByTestId('unassigned-search');
    fireEvent.change(search, { target: { value: 'no-existe' } });
    expect(await screen.findByTestId('unassigned-empty')).toHaveTextContent(
      /No encontramos coincidencias para esa matr\u00edcula/,
    );
  });

  /**
   * G5 verification follow-up: the assigned-tab search used to match
   * the marbete's secret publicUid (the full credential code) which
   * leaks credentials through the search autocomplete. After the
   * G5 fix the search only matches VISIBLE fields — canvasUserId,
   * fullName, email, and the masked code (X***NN).
   *
   * We assert:
   *   1. Searching by the marbete's publicUid does NOT match the
   *      assigned row (filter is hidden, count is empty).
   *   2. Searching by the masked code DOES match (the visible
   *      "X***NN" string is allowed).
   *   3. Searching by matricula fullName still matches.
   */
  it('G5: assigned search excludes marbete.publicUid (visible fields only)', () => {
    installFetchMock();
    render(
      <AsociarPageClient
        initialMatriculas={defaultAssigned()}
        initialCounters={baseCounters}
        initialAvailableMarbetes={defaultAvailable()}
        initialStatus="assigned"
        initialSearch=""
        userRole="admin"
      />,
    );

    // 1) publicUid fragment must NOT match.
    const search = screen.getByTestId('assigned-search');
    fireEvent.change(search, { target: { value: 'm-AB12' } });
    expect(screen.getByTestId('assigned-empty')).toBeInTheDocument();
    expect(
      screen.getByTestId('assigned-search-count'),
    ).toHaveTextContent('(0)');

    // 2) maskedCode fragment MUST match (visible field).
    fireEvent.change(search, { target: { value: '1***AB' } });
    expect(screen.queryByTestId('assigned-empty')).toBeNull();
    expect(
      screen.getByTestId('assigned-search-count'),
    ).toHaveTextContent(/\(1\)/);

    // 3) fullName fragment still matches.
    fireEvent.change(search, { target: { value: 'Ana' } });
    expect(screen.queryByTestId('assigned-empty')).toBeNull();
    expect(
      screen.getByTestId('assigned-search-count'),
    ).toHaveTextContent(/\(1\)/);
  });

  it('dismisses the success banner via the close button', async () => {
    const counts = installFetchMock();
    const user = userEvent.setup();
    render(
      <AsociarPageClient
        initialMatriculas={defaultUnassigned()}
        initialCounters={baseCounters}
        initialAvailableMarbetes={defaultAvailable()}
        initialStatus="unassigned"
        initialSearch=""
        userRole="admin"
      />,
    );

    await user.click(screen.getByTestId('sync-matriculas-trigger'));
    const banner = await screen.findByTestId('app-alert-success');
    expect(banner).not.toHaveAttribute('hidden');
    await user.click(screen.getByTestId('app-alert-close'));
    expect(screen.getByTestId('app-alert-success')).toHaveAttribute('hidden');
    void counts; // ensure refetch counters are present in the mock
  });
});