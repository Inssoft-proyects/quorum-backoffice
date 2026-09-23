import { render, screen } from '@testing-library/react';
import { AuditTable } from '@/app/(authed)/audit/_components/audit-table';
import type { AuditEntry } from '@quorum-backoffice/shared';

const sample: AuditEntry[] = [
  {
    id: 1,
    occurredAt: new Date().toISOString(),
    actorId: 'user-42',
    actorEmail: 'admin@quorum.local',
    action: 'marbete.create',
    entityType: 'marbete',
    entityId: 'm-ABC123',
    beforeJson: null,
    afterJson: { id: 1, publicUid: 'm-ABC123' },
    otpId: 'otp-test-1',
    ip: '127.0.0.1',
    userAgent: 'Mozilla/5.0',
  },
];

describe('AuditTable', () => {
  it('shows empty state when no items', () => {
    render(<AuditTable items={[]} onSelect={() => {}} />);
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
  });

  it('renders rows with action badge + actor + entity', () => {
    render(<AuditTable items={sample} onSelect={() => {}} />);
    expect(screen.getByTestId('audit-row-1')).toBeInTheDocument();
    expect(screen.getByText('admin@quorum.local')).toBeInTheDocument();
    expect(screen.getByText('marbete.create')).toBeInTheDocument();
    expect(screen.getByText(/m-ABC123/)).toBeInTheDocument();
  });

  it('calls onSelect when Ver button clicked', () => {
    const onSelect = jest.fn();
    render(<AuditTable items={sample} onSelect={onSelect} />);
    screen.getByTestId('audit-detail-1').click();
    expect(onSelect).toHaveBeenCalledWith(sample[0]);
  });
});