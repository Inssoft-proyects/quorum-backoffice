import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MarbetesTable } from '@/app/(authed)/marbetes/_components/marbetes-table';
import type { MarbeteDetailResponse } from '@quorum-backoffice/shared';

const baseDate = new Date('2024-01-15T10:00:00Z').toISOString();

const sample: MarbeteDetailResponse[] = [
  {
    id: 1,
    publicUid: 'm-ABC123',
    maskedCode: '1***23',
    status: 'active',
    assignedStudentId: 10,
    assignedAt: new Date().toISOString(),
    createdAt: baseDate,
    createdBy: 'tester',
    deletedAt: null,
    deletionReason: null,
    student: {
      id: 10,
      canvasUserId: 100,
      fullName: 'Ada Lovelace',
      email: 'ada@quorum.local',
    },
  },
  {
    id: 2,
    publicUid: 'm-XYZ789',
    maskedCode: '9***76',
    status: 'active',
    assignedStudentId: null,
    assignedAt: null,
    createdAt: new Date('2024-02-20T10:00:00Z').toISOString(),
    createdBy: 'tester',
    deletedAt: null,
    deletionReason: null,
    student: null,
  },
];

describe('MarbetesTable', () => {
  it('shows empty state when no items', () => {
    render(<MarbetesTable items={[]} userRole="admin" onDelete={() => {}} onEdit={() => {}} />);
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
  });

  it('renders rows with masked code and student info', () => {
    render(<MarbetesTable items={sample} userRole="admin" onDelete={() => {}} onEdit={() => {}} />);
    expect(screen.getByText('1***23')).toBeInTheDocument();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('ada@quorum.local')).toBeInTheDocument();
    expect(screen.getByTestId('marbete-row-1')).toBeInTheDocument();
  });

  it('shows delete button for admin', () => {
    render(<MarbetesTable items={sample} userRole="admin" onDelete={() => {}} onEdit={() => {}} />);
    expect(screen.getByTestId('delete-1')).toBeInTheDocument();
  });

  it('hides delete button for operator', () => {
    render(<MarbetesTable items={sample} userRole="operator" onDelete={() => {}} onEdit={() => {}} />);
    expect(screen.queryByTestId('delete-1')).toBeNull();
  });

  it('renders canon data-table cell classes on load date and validity columns', () => {
    const { container } = render(
      <MarbetesTable items={sample} userRole="admin" onDelete={() => {}} onEdit={() => {}} />,
    );
    // .data-table__date marks the "Fecha de carga" cell.
    expect(container.querySelectorAll('td.data-table__date').length).toBeGreaterThan(0);
    // .data-table__validity wraps the validity column and its inner
    // .data-table__validity-content holds the date + chip.
    expect(container.querySelectorAll('td.data-table__validity').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.data-table__validity-content').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.data-table__validity-date').length).toBeGreaterThan(0);
  });

  it('renders admin-action buttons with the canon SVG sprite refs', () => {
    const { container } = render(
      <MarbetesTable items={sample} userRole="admin" onDelete={() => {}} onEdit={() => {}} />,
    );
    expect(container.querySelectorAll('.admin-action--reveal').length).toBe(2);
    expect(container.querySelectorAll('.admin-action--danger').length).toBe(2);
    expect(container.querySelectorAll('use[href="#icon-reveal"]').length).toBe(2);
    expect(container.querySelectorAll('use[href="#icon-deactivate"]').length).toBe(2);
    // The sprite block must be present in the DOM so the <use href>
    // references resolve to the symbol definitions.
    expect(container.querySelector('symbol#icon-reveal')).toBeTruthy();
    expect(container.querySelector('symbol#icon-deactivate')).toBeTruthy();
  });

  it('renders the four sortable canon headers with aria-sort + data-sort-key', () => {
    const { container } = render(
      <MarbetesTable items={sample} userRole="admin" onDelete={() => {}} onEdit={() => {}} />,
    );
    const sortHeaders = container.querySelectorAll('th.sortable-header');
    expect(sortHeaders.length).toBe(4);
    sortHeaders.forEach((th) => {
      expect(th.getAttribute('aria-sort')).toBe('none');
      expect(th.getAttribute('data-sort-key')).toBeTruthy();
    });
    // Each header should expose a sort-button with the matching
    // data-sort-key and a stable data-testid hook.
    ['id', 'credential', 'loadDate', 'validity'].forEach((key) => {
      expect(screen.getByTestId(`sort-${key}`)).toBeInTheDocument();
    });
  });

  it('cycles sort state none → asc → desc → none on repeated clicks', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <MarbetesTable items={sample} userRole="admin" onDelete={() => {}} onEdit={() => {}} />,
    );
    const idHeader = container.querySelector('th[data-sort-key="id"]') as HTMLElement;
    const idButton = screen.getByTestId('sort-id');
    expect(idHeader.getAttribute('aria-sort')).toBe('none');
    await user.click(idButton);
    expect(idHeader.getAttribute('aria-sort')).toBe('ascending');
    await user.click(idButton);
    expect(idHeader.getAttribute('aria-sort')).toBe('descending');
    await user.click(idButton);
    expect(idHeader.getAttribute('aria-sort')).toBe('none');
  });

  it('sorts rows ascending then descending by ID when the ID header is clicked', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <MarbetesTable items={sample} userRole="admin" onDelete={() => {}} onEdit={() => {}} />,
    );
    const rows = () => Array.from(container.querySelectorAll('tr[data-testid^="marbete-row-"]'));
    const ids = () => rows().map((r) => r.getAttribute('data-testid'));
    // Default order (no sort applied) preserves the input order.
    expect(ids()).toEqual(['marbete-row-1', 'marbete-row-2']);
    await user.click(screen.getByTestId('sort-id'));
    // Ascending: m-ABC123 (id=1) before m-XYZ789 (id=2) — already in
    // order; but the order is computed by publicUid which matches the
    // same ascending direction here.
    expect(ids()).toEqual(['marbete-row-1', 'marbete-row-2']);
    await user.click(screen.getByTestId('sort-id'));
    // Descending reverses the order.
    expect(ids()).toEqual(['marbete-row-2', 'marbete-row-1']);
  });
});