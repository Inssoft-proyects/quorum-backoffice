import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditDialog } from '@/app/(authed)/marbetes/_components/edit-dialog';
import type { MarbeteDetailResponse } from '@quorum-backoffice/shared';

const sample: MarbeteDetailResponse = {
  id: 1,
  publicUid: 'm-XYZ123',
  maskedCode: '1***23',
  status: 'active',
  assignedStudentId: 10,
  assignedAt: new Date().toISOString(),
  createdAt: '',
  createdBy: 'tester',
  deletedAt: null,
  deletionReason: null,
  student: {
    id: 10,
    canvasUserId: 80001,
    fullName: 'Ada Lovelace',
    email: 'ada@quorum.local',
  },
};

describe('EditDialog', () => {
  beforeEach(() => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response('', { status: 404 })) as unknown as typeof fetch;
  });

  it('does not render submit when marbete is null', () => {
    render(<EditDialog marbete={null} onClose={() => {}} />);
    expect(screen.queryByTestId('edit-submit')).toBeNull();
  });

  it('disables submit until OTP has 6 digits', async () => {
    const user = userEvent.setup();
    render(<EditDialog marbete={sample} onClose={() => {}} />);
    const submit = await screen.findByTestId('edit-submit');
    expect(submit).toBeDisabled();
    const otpInputs = screen.getAllByRole('textbox', { name: /Digit/i });
    expect(otpInputs).toHaveLength(6);
    for (const input of otpInputs) {
      await user.type(input, '1');
    }
    expect(submit).not.toBeDisabled();
  });

  it('shows "no changes" error if status matches original and no canvasUserId change', async () => {
    const user = userEvent.setup();
    render(<EditDialog marbete={sample} onClose={() => {}} />);
    const otpInputs = screen.getAllByRole('textbox', { name: /Digit/i });
    for (let i = 0; i < 6; i += 1) {
      await user.type(otpInputs[i]!, '1');
    }
    await user.click(screen.getByTestId('edit-submit'));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/No hay cambios/i);
    });
  });
});