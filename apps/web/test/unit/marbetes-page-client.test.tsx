import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MarbetesPageClient } from '@/app/(authed)/marbetes/_components/marbetes-page-client';
import type { MarbeteDetailResponse } from '@quorum-backoffice/shared';

/**
 * The marbetes page client is the host of the four metric cards, the
 * maquette v2 table, and the global dismissable success banner
 * (.app-alert--success). Reveal keeps its own reveal-confirmation
 * banner below the table; Add / Revoke is what surfaces the
 * app-alert. These specs cover that contract: the banner is hidden
 * by default, fires for Add and Revoke, keeps its role=status and
 * aria-live=polite, carries the icon + title + detail + close
 * structure, and can be dismissed via the close button.
 */

const replaceMock = jest.fn();
const refreshMock = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: replaceMock,
    refresh: refreshMock,
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/backoffice/marbetes',
}));

const baseDate = new Date('2024-01-15T10:00:00Z').toISOString();

function makeMarbete(
  id: number,
  overrides: Partial<MarbeteDetailResponse> = {},
): MarbeteDetailResponse {
  return {
    id,
    publicUid: `m-${id.toString().padStart(4, '0')}`,
    maskedCode: `${id}***00`,
    status: 'active',
    assignedStudentId: null,
    assignedAt: null,
    createdAt: baseDate,
    createdBy: 'tester',
    deletedAt: null,
    deletionReason: null,
    student: null,
    ...overrides,
  };
}

describe('MarbetesPageClient (maquette v2)', () => {
  beforeEach(() => {
    refreshMock.mockClear();
  });

  function installCreateJsonStub(): { read(): { method: string; body: string } } {
    const holder: { current: { method: string; body: string } | null } = { current: null };
    (globalThis as { fetch: typeof fetch }).fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const body = String(init?.body ?? '');
      holder.current = { method: init?.method ?? '', body };
      return new Response(
        JSON.stringify({
          id: 99,
          publicUid: 'm-NEW99',
          maskedCode: '9***00',
          status: 'active',
          assignedStudentId: null,
          assignedAt: null,
          createdAt: new Date().toISOString(),
          createdBy: 'tester',
          deletedAt: null,
          deletionReason: null,
          student: null,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    return {
      read(): { method: string; body: string } {
        if (!holder.current) throw new Error('fetch was not called');
        return holder.current;
      },
    };
  }

  function installDeleteJsonStub(): { read(): { method: string; body: string } } {
    const holder: { current: { method: string; body: string } | null } = { current: null };
    (globalThis as { fetch: typeof fetch }).fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const body = String(init?.body ?? '');
      holder.current = { method: init?.method ?? '', body };
      return new Response(
        JSON.stringify({
          id: 1,
          publicUid: 'm-0001',
          maskedCode: '1***00',
          status: 'active',
          assignedStudentId: null,
          assignedAt: null,
          createdAt: new Date().toISOString(),
          createdBy: 'tester',
          deletedAt: new Date().toISOString(),
          deletionReason: 'Otro',
          student: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    return {
      read(): { method: string; body: string } {
        if (!holder.current) throw new Error('fetch was not called');
        return holder.current;
      },
    };
  }

  it('renders the 4 metric cards, each with a canon .metric-card__filter-chip', () => {
    const { container } = render(
      <MarbetesPageClient items={[makeMarbete(1)]} userRole="admin" />,
    );
    const chips = container.querySelectorAll('[data-filter-chip]');
    expect(chips).toHaveLength(4);
    // Total is the default active filter, so its chip says "Filtro activo".
    expect(chips[0]).toHaveTextContent('Filtro activo');
    // The other three cards start inactive and show "Filtrar".
    expect(chips[1]).toHaveTextContent('Filtrar');
    expect(chips[2]).toHaveTextContent('Filtrar');
    expect(chips[3]).toHaveTextContent('Filtrar');
  });

  it('renders the metrics section with an sr-only <h2> linked by aria-labelledby', () => {
    render(<MarbetesPageClient items={[makeMarbete(1)]} userRole="admin" />);
    const section = screen.getByRole('region', { name: /Indicadores del inventario/i });
    expect(section).toBeInTheDocument();
    const heading = within(section).getByRole('heading', { name: /Indicadores del inventario/i });
    expect(heading.tagName).toBe('H2');
  });

  it('keeps the global success banner hidden on initial render', () => {
    render(<MarbetesPageClient items={[makeMarbete(1)]} userRole="admin" />);
    const alert = screen.getByTestId('app-alert-success');
    expect(alert).toHaveAttribute('hidden');
    expect(alert).toHaveAttribute('role', 'status');
    expect(alert).toHaveAttribute('aria-live', 'polite');
  });

  it('renders the canon alert structure: icon + title + detail + close button', () => {
    const { container } = render(
      <MarbetesPageClient items={[makeMarbete(1)]} userRole="admin" />,
    );
    // Even when hidden, the alert is mounted in the DOM (matches the
    // canon which renders the alert with the hidden attribute and
    // JS-only removes the attribute on show).
    expect(container.querySelector('.app-alert__icon')).toBeInTheDocument();
    expect(container.querySelector('.app-alert__message')).toBeInTheDocument();
    expect(screen.getByTestId('app-alert-close')).toBeInTheDocument();
  });

  it('shows the success banner after Add (handleAdded) with the canon title + detail copy', async () => {
    const user = userEvent.setup();
    installCreateJsonStub();
    render(<MarbetesPageClient items={[makeMarbete(1)]} userRole="admin" />);

    // Open the AddMarbeteDialog. The AddMarbeteDialog calls its own
    // fetch + onSaved when the user submits a valid code; we exercise
    // the onSaved path by clicking the trigger + simulating a submit.
    await user.click(screen.getByTestId('add-marbete-trigger'));
    const codeInput = await screen.findByTestId('credential-number-input');
    await user.type(codeInput, '91234567');
    // D-3: the AddMarbeteDialog now requires an OTP when no grant is
    // active. Type one so the submit button enables.
    const otpInputs = (await screen.findAllByRole("textbox", { name: /Digit/i })) as HTMLInputElement[];
    for (let i = 0; i < 'AB12CD'.length; i += 1) {
      await user.type(otpInputs[i]!, 'AB12CD'[i]!);
    }
    await user.click(screen.getByTestId('add-marbete-submit'));

    // The success banner is now visible with the canonical title +
    // detail copy. The api-client.fetch stub returns 201 → onSaved
    // fires → handleAdded runs → setInfoBanner updates the state.
    const alert = await screen.findByTestId('app-alert-success');
    expect(alert).not.toHaveAttribute('hidden');
    expect(within(alert).getByTestId('app-alert-title')).toHaveTextContent('Marbete guardado.');
    expect(within(alert).getByTestId('app-alert-detail')).toHaveTextContent(
      'Se registró en el inventario con estado Disponible.',
    );
  });

  it('keeps the Reveal flow separate from the global success banner', async () => {
    const user = userEvent.setup();
    render(<MarbetesPageClient items={[makeMarbete(1)]} userRole="admin" />);

    // Open the reveal dialog from the row's reveal button.
    await user.click(screen.getByTestId('reveal-1'));
    const reasonSelect = await screen.findByTestId('reveal-reason-select');
    await user.selectOptions(reasonSelect, 'auditoria');

    // Reveal hits POST /api/v1/marbetes/:id/reveal which is not stubbed
    // here, so we expect an inline error rather than a successful
    // confirmation. The relevant invariant: the global app-alert
    // banner stays hidden, and no Marbete guardado. text leaks in.
    const alert = screen.getByTestId('app-alert-success');
    expect(alert).toHaveAttribute('hidden');
    expect(within(alert).getByTestId('app-alert-title')).not.toHaveTextContent('Marbete guardado.');
  });

  it('dismisses the success banner when the close button is clicked', async () => {
    const user = userEvent.setup();
    installCreateJsonStub();
    render(<MarbetesPageClient items={[makeMarbete(1)]} userRole="admin" />);

    await user.click(screen.getByTestId('add-marbete-trigger'));
    const codeInput = await screen.findByTestId('credential-number-input');
    await user.type(codeInput, '91234567');
    // D-3: the AddMarbeteDialog now requires an OTP when no grant is
    // active. Type one so the submit button enables.
    const otpInputs = (await screen.findAllByRole("textbox", { name: /Digit/i })) as HTMLInputElement[];
    for (let i = 0; i < 'AB12CD'.length; i += 1) {
      await user.type(otpInputs[i]!, 'AB12CD'[i]!);
    }
    await user.click(screen.getByTestId('add-marbete-submit'));

    const alert = await screen.findByTestId('app-alert-success');
    expect(alert).not.toHaveAttribute('hidden');
    await user.click(screen.getByTestId('app-alert-close'));
    expect(screen.getByTestId('app-alert-success')).toHaveAttribute('hidden');
  });

  it('shows the success banner after Revoke (handleRevoked) with the canon title copy', async () => {
    const user = userEvent.setup();
    installDeleteJsonStub();
    render(<MarbetesPageClient items={[makeMarbete(1)]} userRole="admin" />);

    await user.click(screen.getByTestId('delete-1'));
    const reasonSelect = await screen.findByTestId('deactivate-reason-select');
    await user.selectOptions(reasonSelect, 'otro');
    await user.click(screen.getByTestId('revoke-marbete-submit'));

    const alert = await screen.findByTestId('app-alert-success');
    expect(alert).not.toHaveAttribute('hidden');
    expect(within(alert).getByTestId('app-alert-title')).toHaveTextContent('Marbete dado de baja.');
    expect(within(alert).getByTestId('app-alert-detail')).toHaveTextContent(
      'El marbete dejó de estar en circulación.',
    );
  });
});