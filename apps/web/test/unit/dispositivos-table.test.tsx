import { render, screen } from '@testing-library/react';
import { DispositivosTable } from '@/app/(authed)/dispositivos/_components/dispositivos-table';
import type { DispositivoDetailResponse } from '@quorum-backoffice/shared';

const sample: DispositivoDetailResponse[] = [
  {
    id: 1,
    serialNumber: 'SN-WU9-001',
    brand: 'Apple',
    model: 'iPad Pro',
    status: 'active',
    createdAt: '',
    createdBy: 'tester',
    revokedAt: null,
    revokedReason: null,
  },
  {
    id: 2,
    serialNumber: 'SN-WU9-002',
    brand: null,
    model: null,
    status: 'revoked',
    createdAt: '',
    createdBy: 'tester',
    revokedAt: new Date().toISOString(),
    revokedReason: 'lost',
  },
];

describe('DispositivosTable', () => {
  it('shows empty state when no items', () => {
    render(<DispositivosTable items={[]} userRole="admin" onEdit={() => {}} onRevoke={() => {}} />);
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
  });

  it('renders rows with full serial + status badge + brand/model', () => {
    render(<DispositivosTable items={sample} userRole="admin" onEdit={() => {}} onRevoke={() => {}} />);
    expect(screen.getByText('SN-WU9-001')).toBeInTheDocument();
    expect(screen.getByText('SN-WU9-002')).toBeInTheDocument();
    expect(screen.getByText('Activo')).toBeInTheDocument();
    expect(screen.getByText('Revocado')).toBeInTheDocument();
    expect(screen.getByText('Apple')).toBeInTheDocument();
    expect(screen.getByTestId('dispositivo-row-1')).toBeInTheDocument();
  });

  it('shows Revoke only for active dispositivos (admin)', () => {
    render(<DispositivosTable items={sample} userRole="admin" onEdit={() => {}} onRevoke={() => {}} />);
    expect(screen.getByTestId('revoke-1')).toBeInTheDocument();
    expect(screen.queryByTestId('revoke-2')).toBeNull();
  });

  it('hides action buttons for operator', () => {
    render(<DispositivosTable items={sample} userRole="operator" onEdit={() => {}} onRevoke={() => {}} />);
    expect(screen.queryByTestId('edit-1')).toBeNull();
    expect(screen.queryByTestId('revoke-1')).toBeNull();
  });
});