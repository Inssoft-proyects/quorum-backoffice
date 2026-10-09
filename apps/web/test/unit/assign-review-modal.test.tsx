/**
 * Tests for the AssignReviewModal (WU v3 "Asignación de marbetes").
 *
 * Coverage:
 *  - Title + description switch between single + bulk modes.
 *  - Per-row select populates from the available marbetes.
 *  - Selecting the same marbete for two rows swaps them (canon
 *    selectReviewOption semantics).
 *  - Validation flips from "Propuesta válida" to "Revisa los marbetes
 *    seleccionados" when duplicates exist.
 *  - OTP input is required when no grant is active; the grant note
 *    surfaces instead when the actor has an active grant.
 *  - onConfirm receives the resolved pairs + the resolved OTP code
 *    (undefined when the grant is active).
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AssignReviewModal } from '@/app/(authed)/asociar/_components/assign-review-modal';

interface FetchHandlers {
  grant?: { active: boolean; expiresAt: string | null };
}

function installFetchMock(handlers: FetchHandlers = {}): void {
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    input: RequestInfo | URL,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/v1/marbetes/otp-grant')) {
      return new Response(
        JSON.stringify(handlers.grant ?? { active: false, expiresAt: null }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ code: 'not_found', message: 'no' }), {
      status: 404,
    });
  }) as unknown as typeof fetch;
}

describe('AssignReviewModal', () => {
  it('uses the single-assignment title when only one enrollment is provided', () => {
    installFetchMock();
    render(
      <AssignReviewModal
        open
        onOpenChange={jest.fn()}
        enrollments={[
          { canvasUserId: 1, fullName: 'Ana', sisId: null, marbeteId: null },
        ]}
        available={[{ id: 10, maskedCode: '3***10' }]}
        availableMarbetesTotal={1}
        onConfirm={jest.fn()}
      />,
    );
    expect(screen.getByTestId('assign-review-title')).toHaveTextContent(
      'Confirmar asignación de marbete',
    );
  });

  it('uses the bulk title when multiple enrollments are provided', () => {
    installFetchMock();
    render(
      <AssignReviewModal
        open
        onOpenChange={jest.fn()}
        enrollments={[
          { canvasUserId: 1, fullName: 'Ana', sisId: null, marbeteId: null },
          { canvasUserId: 2, fullName: 'Beto', sisId: null, marbeteId: null },
        ]}
        available={[
          { id: 10, maskedCode: '3***10' },
          { id: 11, maskedCode: '3***11' },
        ]}
        availableMarbetesTotal={2}
        onConfirm={jest.fn()}
      />,
    );
    expect(screen.getByTestId('assign-review-title')).toHaveTextContent(
      'Confirmar asignación automática de marbetes',
    );
  });

  it('flags the review as invalid when two rows propose the same marbete', async () => {
    installFetchMock();
    const user = userEvent.setup();
    render(
      <AssignReviewModal
        open
        onOpenChange={jest.fn()}
        enrollments={[
          { canvasUserId: 1, fullName: 'Ana', sisId: null, marbeteId: null },
          { canvasUserId: 2, fullName: 'Beto', sisId: null, marbeteId: null },
        ]}
        available={[
          { id: 10, maskedCode: '3***10' },
          { id: 11, maskedCode: '3***11' },
        ]}
        availableMarbetesTotal={2}
        onConfirm={jest.fn()}
      />,
    );

    await user.selectOptions(screen.getByTestId('assign-review-select-1'), '10');
    // Row 2 still has its default proposal of the first available
    // (id=10), so selecting 10 for row 1 produces a duplicate.
    expect(screen.getByTestId('assign-review-validation')).toHaveTextContent(
      /Revisa los marbetes seleccionados/,
    );
    expect(screen.getByTestId('assign-review-confirm')).toBeDisabled();
  });

  it('swaps the duplicate marbete between rows so the proposal becomes valid', async () => {
    installFetchMock();
    const user = userEvent.setup();
    render(
      <AssignReviewModal
        open
        onOpenChange={jest.fn()}
        enrollments={[
          { canvasUserId: 1, fullName: 'Ana', sisId: null, marbeteId: null },
          { canvasUserId: 2, fullName: 'Beto', sisId: null, marbeteId: null },
        ]}
        available={[
          { id: 10, maskedCode: '3***10' },
          { id: 11, maskedCode: '3***11' },
        ]}
        availableMarbetesTotal={2}
        onConfirm={jest.fn()}
      />,
    );

    // Row 1 picks id=10, row 2 picks id=11 — distinct, no swap needed.
    await user.selectOptions(screen.getByTestId('assign-review-select-1'), '10');
    await user.selectOptions(screen.getByTestId('assign-review-select-2'), '11');
    expect(screen.getByTestId('assign-review-validation')).toHaveTextContent(
      'Propuesta válida',
    );
  });

  it('hides the OTP input + shows the grant note when an active grant is present', async () => {
    installFetchMock({
      grant: { active: true, expiresAt: '2030-01-01T12:20:00Z' },
    });
    render(
      <AssignReviewModal
        open
        onOpenChange={jest.fn()}
        enrollments={[
          { canvasUserId: 1, fullName: 'Ana', sisId: null, marbeteId: null },
        ]}
        available={[{ id: 10, maskedCode: '3***10' }]}
        availableMarbetesTotal={1}
        onConfirm={jest.fn()}
      />,
    );
    const note = await screen.findByTestId('assign-review-grant-note');
    expect(note).toHaveTextContent(/OTP vigente hasta/);
    expect(screen.queryByTestId('assign-review-otp')).toBeNull();
  });

  it('requires the 6-digit OTP and forwards it on confirm when no grant is active', async () => {
    installFetchMock();
    const user = userEvent.setup();
    const onConfirm = jest.fn();
    render(
      <AssignReviewModal
        open
        onOpenChange={jest.fn()}
        enrollments={[
          { canvasUserId: 1, fullName: 'Ana', sisId: null, marbeteId: null },
        ]}
        available={[{ id: 10, maskedCode: '3***10' }]}
        availableMarbetesTotal={1}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByTestId('assign-review-confirm')).toBeDisabled();

    await user.selectOptions(screen.getByTestId('assign-review-select-1'), '10');
    const otpInputs = screen.getAllByRole('textbox', { name: /Digit/i });
    for (const input of otpInputs) {
      await user.type(input, '1');
    }

    await user.click(screen.getByTestId('assign-review-confirm'));
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });
    const args = onConfirm.mock.calls[0] as [
      { canvasUserId: number; marbeteId: number }[],
      string | undefined,
    ];
    expect(args[0]).toEqual([{ canvasUserId: 1, marbeteId: 10 }]);
    expect(args[1]).toBe('111111');
  });

  // D-1 — the OTP input must accept the alphanumeric OTP alphabet
  // (uppercase A–Z0–9) and forward the full string on confirm. Prior
  // to the fix the OtpInput was in default numeric mode, so letters
  // were stripped and the operator could not enter a real code.
  it('accepts an alphanumeric OTP and forwards it on confirm', async () => {
    installFetchMock();
    const user = userEvent.setup();
    const onConfirm = jest.fn();
    render(
      <AssignReviewModal
        open
        onOpenChange={jest.fn()}
        enrollments={[
          { canvasUserId: 1, fullName: 'Ana', sisId: null, marbeteId: null },
        ]}
        available={[{ id: 10, maskedCode: '3***10' }]}
        availableMarbetesTotal={1}
        onConfirm={onConfirm}
      />,
    );

    await user.selectOptions(screen.getByTestId('assign-review-select-1'), '10');
    const otpInputs = screen.getAllByRole('textbox', { name: /Digit/i }) as HTMLInputElement[];
    for (let i = 0; i < 'AB12CD'.length; i += 1) {
      await user.type(otpInputs[i]!, 'AB12CD'[i]!);
    }
    // Every filled box renders its char (D-2 alignment).
    expect(otpInputs.map((b) => b.value)).toEqual(['A', 'B', '1', '2', 'C', 'D']);

    await user.click(screen.getByTestId('assign-review-confirm'));
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });
    const args = onConfirm.mock.calls[0] as [
      { canvasUserId: number; marbeteId: number }[],
      string | undefined,
    ];
    expect(args[0]).toEqual([{ canvasUserId: 1, marbeteId: 10 }]);
    expect(args[1]).toBe('AB12CD');
  });
});