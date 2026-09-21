import { render, screen } from '@testing-library/react';
import { MarbetesTable } from '@/app/(authed)/marbetes/_components/marbetes-table';
import type { MarbeteDetailResponse } from '@quorum-backoffice/shared';

const sample: MarbeteDetailResponse[] = [
  {
    id: 1,
    publicUid: 'm-ABC123',
    maskedCode: '1***23',
    status: 'active',
    assignedStudentId: 10,
    assignedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
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
];

describe('MarbetesTable', () => {
  it('shows empty state when no items', () => {
    render(<MarbetesTable items={[]} userRole="admin" onDelete={() => {}} />);
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
  });

  it('renders rows with masked code and student info', () => {
    render(<MarbetesTable items={sample} userRole="admin" onDelete={() => {}} />);
    expect(screen.getByText('1***23')).toBeInTheDocument();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('ada@quorum.local')).toBeInTheDocument();
    expect(screen.getByTestId('marbete-row-1')).toBeInTheDocument();
  });

  it('shows delete button for admin', () => {
    render(<MarbetesTable items={sample} userRole="admin" onDelete={() => {}} />);
    expect(screen.getByTestId('delete-1')).toBeInTheDocument();
  });

  it('hides delete button for operator', () => {
    render(<MarbetesTable items={sample} userRole="operator" onDelete={() => {}} />);
    expect(screen.queryByTestId('delete-1')).toBeNull();
  });
});
