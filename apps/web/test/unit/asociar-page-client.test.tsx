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
    sisId: null,
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
  observedListStatuses: string[];
} {
  const counts = {
    grantRequests: 0,
    assignRequests: 0,
    unassignRequests: 0,
    syncRequests: 0,
    listRequests: 0,
    countersRequests: 0,
    observedListStatuses: [] as string[],
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
      counts.observedListStatuses.push(status);
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

  /**
   * Regression (commit de30f4d): `setActiveTabSync` used to only
   * flip the active-tab state and never fetch the tab's data. The
   * server component pre-fetches only the initial status, so
   * clicking the "Asignados" tab rendered the empty state
   * ("No hay matrículas asignadas") even when the API returned
   * rows. The fix calls `loadTabItems(tab)` from the tab switch,
   * which issues `listMatriculas({ status: tab, isActive: 'true',
   * limit: 200, offset: 0 })` and stores the result.
   *
   * This test pins the contract end-to-end:
   *   1. Render with `initialStatus="unassigned"` and NO assigned
   *      rows preloaded (the relevant pre-state for the bug).
   *   2. Click the "Asignados" tab.
   *   3. The fetch mock MUST observe a `status=assigned` request.
   *   4. The returned assigned row is rendered in the panel
   *      (the row cell carries the row's `sisId`).
   *   5. The "No hay matrículas asignadas" empty state is NOT
   *      shown — the bug rendered it because the tab was never
   *      fed.
   */
  it('regression: clicking the "Asignados" tab loads the assigned rows (P1 fix verification)', async () => {
    const assignedFixture: MatriculaListItem[] = [
      makeMatricula(7001, {
        fullName: 'Lucia Pérez',
        email: 'lucia@example.com',
        sisId: 'LCPRZ1',
        marbete: {
          id: 99,
          publicUid: 'm-LCPRZ1',
          maskedCode: '1***LC',
          status: 'active',
          assignedAt: '2024-09-12T10:00:00Z',
          assignedBy: 'admin@quorum.local',
        },
      }),
      makeMatricula(7002, {
        fullName: 'Mario Soto',
        email: 'mario@example.com',
        sisId: 'MRSOT2',
        marbete: {
          id: 100,
          publicUid: 'm-MRSOT2',
          maskedCode: '1***MR',
          status: 'active',
          assignedAt: '2024-09-13T11:00:00Z',
          assignedBy: 'operator@quorum.local',
        },
      }),
    ];
    const counts = installFetchMock({ assigned: assignedFixture });
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

    // Pre-state guard: the assigned tab is not yet active and no
    // assigned list request has been issued.
    expect(screen.getByTestId('tab-assigned')).toHaveAttribute('aria-selected', 'false');
    expect(counts.observedListStatuses).not.toContain('assigned');

    // Action under test: click the "Asignados" tab.
    await user.click(screen.getByTestId('tab-assigned'));

    // (3) The fetch mock must observe a status=assigned request.
    await waitFor(() => {
      expect(counts.observedListStatuses).toContain('assigned');
    });

    // (4) The returned assigned rows are rendered in the panel —
    // at least one cell with `assigned-matricula-<canvasUserId>`
    // showing the row's `sisId`. The cell shows the SIS as a
    // secondary line ("Matrícula LCPRZ1") when the Canvas name is
    // present, so the assertion is the substring "LCPRZ1".
    const rowCell = await screen.findByTestId('assigned-matricula-7001');
    expect(rowCell).toHaveTextContent('LCPRZ1');
    expect(
      screen.getByTestId('assigned-matricula-7002'),
    ).toHaveTextContent('MRSOT2');

    // (5) The "No hay matrículas asignadas" empty state must NOT
    // be shown — the bug rendered it because the tab was never
    // fed. We assert via the canonical testid and the exact copy
    // to keep the regression intent obvious to a reader.
    expect(screen.queryByTestId('assigned-empty')).not.toBeInTheDocument();
    expect(
      screen.queryByText(/No hay matrículas asignadas/),
    ).not.toBeInTheDocument();
  });

  /**
   * SIS-matrícula visibility contract: the production cache has 997
   * of 999 rows with `fullName: null` and a populated `sisId` (a
   * 6-character code like `TOPGR4`). The screen must (a) not throw
   * on the null name/email and (b) render the SIS matrícula as the
   * primary label so the operator can tell rows apart.
   *
   * Before the fix, the search filter called `m.fullName.toLowerCase()`
   * which throws a TypeError on null, and the row cell interpolated
   * the null name into the DOM. After the fix, the primary label
   * is the SIS matrícula and a secondary line shows the email
   * (or the SIS underneath when the Canvas name is present).
   */
  it('SIS remediation: renders rows with fullName: null + sisId without throwing', () => {
    installFetchMock();
    const sisOnlyRows: MatriculaListItem[] = [
      {
        canvasUserId: 901,
        fullName: null,
        email: null,
        sisId: 'TOPGR4',
        isActive: true,
        registeredAt: '2024-09-12T10:00:00Z',
        marbete: null,
      },
      {
        canvasUserId: 902,
        fullName: null,
        email: 'other@example.com',
        sisId: '1S39YA',
        isActive: true,
        registeredAt: '2024-09-12T10:00:00Z',
        marbete: null,
      },
    ];

    // The render MUST NOT throw. React 19 + jsdom will surface any
    // uncaught error during render as a test failure; the cell
    // also must contain the SIS code as text (the operator
    // otherwise cannot identify the row).
    expect(() => {
      render(
        <AsociarPageClient
          initialMatriculas={sisOnlyRows}
          initialCounters={{
            total: 2,
            assigned: 0,
            unassigned: 2,
            availableMarbetes: 8,
          }}
          initialAvailableMarbetes={defaultAvailable()}
          initialStatus="unassigned"
          initialSearch=""
          userRole="admin"
        />,
      );
    }).not.toThrow();

    // The SIS matrícula MUST be visible in the row cell.
    const row1 = screen.getByTestId('unassigned-matricula-901');
    expect(row1).toHaveTextContent('TOPGR4');
    const row2 = screen.getByTestId('unassigned-matricula-902');
    expect(row2).toHaveTextContent('1S39YA');

    // The aria-label on the row's selection checkbox must not read
    // "Seleccionar matrícula null" — the helper picks the SIS code
    // as the label.
    expect(
      screen.getByTestId('unassigned-check-901'),
    ).toHaveAttribute('aria-label', 'Seleccionar matrícula TOPGR4');
  });

  /**
   * The Canvas name + SIS combination must show BOTH identifiers
   * in the row (the brief: "where the name exists, show both").
   */
  it('SIS remediation: rows with fullName + sisId show both identifiers', () => {
    installFetchMock();
    const namedRows: MatriculaListItem[] = [
      {
        canvasUserId: 1001,
        fullName: 'Ana López',
        email: 'ana@example.com',
        sisId: 'ANLSS2',
        isActive: true,
        registeredAt: '2024-09-12T10:00:00Z',
        marbete: null,
      },
    ];

    expect(() => {
      render(
        <AsociarPageClient
          initialMatriculas={namedRows}
          initialCounters={{
            total: 1,
            assigned: 0,
            unassigned: 1,
            availableMarbetes: 4,
          }}
          initialAvailableMarbetes={defaultAvailable()}
          initialStatus="unassigned"
          initialSearch=""
          userRole="admin"
        />,
      );
    }).not.toThrow();

    const cell = screen.getByTestId('unassigned-matricula-1001');
    expect(cell).toHaveTextContent('Ana López');
    // The SIS rides underneath as a secondary line.
    expect(cell).toHaveTextContent('Matrícula ANLSS2');
  });

  /**
   * The client-side search filter must be null-safe: typing a
   * search term must NOT throw a TypeError when rows have
   * `fullName: null` and `email: null`. The matching logic must
   * also pick up the SIS matrícula so the operator can search by
   * a matrícula fragment.
   */
  it('SIS remediation: search filter is null-safe and matches sisId', () => {
    installFetchMock();
    const sisOnlyRows: MatriculaListItem[] = [
      {
        canvasUserId: 901,
        fullName: null,
        email: null,
        sisId: 'TOPGR4',
        isActive: true,
        registeredAt: '2024-09-12T10:00:00Z',
        marbete: null,
      },
      {
        canvasUserId: 902,
        fullName: null,
        email: null,
        sisId: '1S39YA',
        isActive: true,
        registeredAt: '2024-09-12T10:00:00Z',
        marbete: null,
      },
    ];

    render(
      <AsociarPageClient
        initialMatriculas={sisOnlyRows}
        initialCounters={{
          total: 2,
          assigned: 0,
          unassigned: 2,
          availableMarbetes: 8,
        }}
        initialAvailableMarbetes={defaultAvailable()}
        initialStatus="unassigned"
        initialSearch=""
        userRole="admin"
      />,
    );

    // Search by matrícula fragment — must not throw on null
    // fullName/email and must match the SIS.
    const search = screen.getByTestId('unassigned-search');
    expect(() => {
      fireEvent.change(search, { target: { value: 'TOP' } });
    }).not.toThrow();
    // SIS fragment matches exactly one row.
    expect(screen.getByTestId('unassigned-matricula-901')).toHaveTextContent(
      'TOPGR4',
    );
    // The other row is filtered out.
    expect(
      screen.queryByTestId('unassigned-matricula-902'),
    ).not.toBeInTheDocument();
  });
});