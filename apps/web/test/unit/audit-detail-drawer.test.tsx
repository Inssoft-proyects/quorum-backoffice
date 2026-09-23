import { render, screen, within } from '@testing-library/react';
import { AuditDetailDrawer } from '@/app/(authed)/audit/_components/audit-detail-drawer';
import type { AuditEntry } from '@quorum-backoffice/shared';

const sample: AuditEntry = {
  id: 7,
  occurredAt: '2025-11-21T10:00:00.000Z',
  actorId: 'tester',
  actorEmail: 'tester@x.com',
  action: 'dispositivo.create',
  entityType: 'dispositivo',
  entityId: '42',
  beforeJson: null,
  afterJson: { id: 42, serialNumber: 'SN-X', status: 'active' },
  otpId: 'otp-detail-7',
  ip: '10.0.0.1',
  userAgent: 'jest',
};

describe('AuditDetailDrawer', () => {
  it('renders nothing actionable when entry is null', () => {
    render(<AuditDetailDrawer entry={null} onClose={() => {}} />);
    expect(screen.queryByTestId('audit-detail')).toBeNull();
  });

  it('renders entry metadata when provided', () => {
    render(<AuditDetailDrawer entry={sample} onClose={() => {}} />);
    const root = screen.getByTestId('audit-detail');
    expect(within(root).getByText(/tester@x.com/)).toBeInTheDocument();
    expect(within(root).getByText('dispositivo.create')).toBeInTheDocument();
    // SN-X is embedded inside the JSON <pre> alongside other content, so
    // match it via a substring regex (consistent with the .toContain
    // assertion in the next test).
    expect(within(root).getByText(/SN-X/)).toBeInTheDocument();
  });

  it('renders Before and After JSON blocks', () => {
    render(<AuditDetailDrawer entry={sample} onClose={() => {}} />);
    const before = screen.getByTestId('before-json');
    const after = screen.getByTestId('after-json');
    expect(before.textContent).toBe('—'); // null in sample
    expect(after.textContent).toContain('SN-X');
  });
});