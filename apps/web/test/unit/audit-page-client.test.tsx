import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuditPageClient } from '@/app/(authed)/audit/_components/audit-page-client';
import type { AuditEntry } from '@quorum-backoffice/shared';

const replaceMock = jest.fn();
const refreshMock = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: replaceMock,
    refresh: refreshMock,
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/audit',
}));

/**
 * Sample audit entries covering all three entity prefixes plus a login
 * failure so the metric-card counts and the in-memory filter both have
 * something to discriminate.
 *
 * Timestamps are deliberately spread across 2024-2025 so the sort tests
 * can verify ascending vs descending ordering without flakiness.
 */
const SAMPLE_ITEMS: AuditEntry[] = [
  {
    id: 1,
    occurredAt: '2024-01-15T12:00:00.000Z',
    actorId: 'admin@quorum.local',
    actorEmail: 'admin@quorum.local',
    action: 'marbete.create',
    entityType: 'marbete',
    entityId: 'm-AB12CD',
    beforeJson: null,
    afterJson: { id: 1, publicUid: 'm-AB12CD' },
    otpId: null,
    ip: '10.0.0.1',
    userAgent: 'jest',
  },
  {
    id: 2,
    occurredAt: '2024-06-15T12:00:00.000Z',
    actorId: 'admin@quorum.local',
    actorEmail: 'admin@quorum.local',
    action: 'dispositivo.create',
    entityType: 'dispositivo',
    entityId: 'SN-0001',
    beforeJson: null,
    afterJson: { id: 1, serialNumber: 'SN-0001' },
    otpId: null,
    ip: '10.0.0.1',
    userAgent: 'jest',
  },
  {
    id: 3,
    occurredAt: '2025-01-15T12:00:00.000Z',
    actorId: 'operator@quorum.local',
    actorEmail: 'operator@quorum.local',
    action: 'marbete.assign',
    entityType: 'marbete',
    entityId: 'm-EF34GH',
    beforeJson: null,
    afterJson: { id: 2, publicUid: 'm-EF34GH' },
    otpId: 'otp-test-3',
    ip: '10.0.0.2',
    userAgent: 'jest',
  },
  {
    id: 4,
    occurredAt: '2025-06-15T12:00:00.000Z',
    actorId: 'unknown@quorum.local',
    actorEmail: null,
    action: 'auth.failed',
    entityType: 'session',
    entityId: null,
    beforeJson: null,
    afterJson: { reason: 'bad-password' },
    otpId: null,
    ip: '10.0.0.99',
    userAgent: 'jest',
  },
];

describe('AuditPageClient (v2)', () => {
  beforeEach(() => {
    replaceMock.mockClear();
    refreshMock.mockClear();
  });

  it('T1: renders the 4 metric cards (Total / Marbetes / Dispositivos / Autenticación) when items are provided', () => {
    render(<AuditPageClient items={SAMPLE_ITEMS} total={SAMPLE_ITEMS.length} />);

    // Each metric card is rendered as a <button data-filter="…">. Use
    // exact-prefix matching (mirrors the e2e lookfeel spec) so the
    // card label "Marbetes" does not collide with the table row chip
    // text for the `marbete.create` action.
    expect(
      screen.getByRole('button', { name: /^Total\b/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^Marbetes\b/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^Dispositivos\b/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^Autenticación\b/ }),
    ).toBeInTheDocument();
  });

  it('T2: clicking the Marbetes MetricCard filters the visible rows to only marbete.* actions', async () => {
    const user = userEvent.setup();
    render(<AuditPageClient items={SAMPLE_ITEMS} total={SAMPLE_ITEMS.length} />);

    // All four rows are visible before filtering.
    const initialRows = screen.getAllByTestId(/^audit-row-/);
    expect(initialRows).toHaveLength(SAMPLE_ITEMS.length);

    // Click the Marbetes card.
    await user.click(screen.getByRole('button', { name: /^Marbetes\b/ }));

    // After filtering, only the 2 marbete.* rows remain visible.
    const filteredRows = screen.getAllByTestId(/^audit-row-/);
    expect(filteredRows).toHaveLength(2);

    // Sanity: at least one of the remaining rows carries a marbete.*
    // chip and none of them carry a dispositivo.* / auth.* chip.
    expect(screen.getByText('marbete.create')).toBeInTheDocument();
    expect(screen.getByText('marbete.assign')).toBeInTheDocument();
    expect(screen.queryByText('dispositivo.create')).not.toBeInTheDocument();
    expect(screen.queryByText('auth.failed')).not.toBeInTheDocument();
  });

  it('T3: clicking the Fecha SortHeader sorts descending by occurredAt; clicking again flips to ascending', async () => {
    const user = userEvent.setup();
    render(<AuditPageClient items={SAMPLE_ITEMS} total={SAMPLE_ITEMS.length} />);

    // Click "Fecha" once → desc (most recent first → id 4).
    await user.click(screen.getByTestId('sort-occurredAt'));
    let firstRow = screen.getAllByTestId(/^audit-row-/)[0];
    expect(firstRow).toHaveAttribute('data-testid', 'audit-row-4');

    // Click again → asc (oldest first → id 1).
    await user.click(screen.getByTestId('sort-occurredAt'));
    firstRow = screen.getAllByTestId(/^audit-row-/)[0];
    expect(firstRow).toHaveAttribute('data-testid', 'audit-row-1');
  });

  it('clicking the Total MetricCard resets the in-memory filter to show every row', async () => {
    const user = userEvent.setup();
    render(<AuditPageClient items={SAMPLE_ITEMS} total={SAMPLE_ITEMS.length} />);

    await user.click(screen.getByRole('button', { name: /^Marbetes\b/ }));
    expect(screen.getAllByTestId(/^audit-row-/)).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: /^Total\b/ }));

    const allRows = screen.getAllByTestId(/^audit-row-/);
    expect(allRows).toHaveLength(SAMPLE_ITEMS.length);
    // Drawer root remains absent in the closed state.
    expect(screen.queryByTestId('audit-detail')).not.toBeInTheDocument();
    // Within the first row, the AUD-#### IdBadge renders the entry id.
    const firstRow = allRows[0];
    expect(firstRow).toBeDefined();
    expect(within(firstRow as HTMLElement).getByText(/^AUD-\d{4}$/)).toBeInTheDocument();
  });

  it('clicking the Dispositivos MetricCard filters the visible rows to only dispositivo.* actions', async () => {
    const user = userEvent.setup();
    render(<AuditPageClient items={SAMPLE_ITEMS} total={SAMPLE_ITEMS.length} />);

    await user.click(screen.getByRole('button', { name: /^Dispositivos\b/ }));

    const filteredRows = screen.getAllByTestId(/^audit-row-/);
    expect(filteredRows).toHaveLength(1);
    expect(screen.getByText('dispositivo.create')).toBeInTheDocument();
    expect(screen.queryByText('marbete.create')).not.toBeInTheDocument();
  });

  it('clicking the ID SortHeader sorts ascending by id, then descending', async () => {
    const user = userEvent.setup();
    render(<AuditPageClient items={SAMPLE_ITEMS} total={SAMPLE_ITEMS.length} />);

    // Click ID → ascending → first row is id 1.
    await user.click(screen.getByTestId('sort-id'));
    let firstRow = screen.getAllByTestId(/^audit-row-/)[0];
    expect(firstRow).toHaveAttribute('data-testid', 'audit-row-1');

    // Click ID again → descending → first row is id 4.
    await user.click(screen.getByTestId('sort-id'));
    firstRow = screen.getAllByTestId(/^audit-row-/)[0];
    expect(firstRow).toHaveAttribute('data-testid', 'audit-row-4');
  });
});
