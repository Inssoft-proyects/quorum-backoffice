import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OtpInput, type OtpInputMode } from '@/components/ui/otp-input';

/**
 * Stateful harness. The OtpInput is a fully-controlled component — its
 * `value` prop drives the rendered characters and the boxes will only
 * reflect what the parent stores. Tests that need to observe multi-keystroke
 * behaviour MUST drive the parent state; otherwise the controlled input
 * silently reverts each render.
 */
function ControlledOtp({
  mode = 'numeric',
  initial = '',
  onLastChange,
}: {
  mode?: OtpInputMode;
  initial?: string;
  onLastChange?: (v: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <OtpInput
        mode={mode}
        value={value}
        onChange={(v) => {
          setValue(v);
          onLastChange?.(v);
        }}
        autoFocus={false}
      />
      <output data-testid="current-value">{value}</output>
    </>
  );
}

function getBoxes(): HTMLInputElement[] {
  const group = screen.getByRole('group', { name: /OTP code/i });
  return Array.from(group.querySelectorAll<HTMLInputElement>('input'));
}

describe('OtpInput — default numeric mode (backward compatibility)', () => {
  it('renders 6 boxes by default with inputMode=numeric', () => {
    render(<ControlledOtp />);
    const boxes = getBoxes();
    expect(boxes).toHaveLength(6);
    for (const box of boxes) {
      expect(box).toHaveAttribute('inputmode', 'numeric');
    }
  });

  it('accepts the last digit typed into a box and auto-advances', async () => {
    const user = userEvent.setup();
    const onLastChange = jest.fn();
    render(<ControlledOtp onLastChange={onLastChange} />);
    const boxes = getBoxes();
    await user.type(boxes[0]!, '1');
    expect(boxes[0]!.value).toBe('1');
    expect(onLastChange).toHaveBeenLastCalledWith('1');
    expect(document.activeElement).toBe(boxes[1]!);
  });

  it('strips non-digit characters typed into a single box', async () => {
    const user = userEvent.setup();
    render(<ControlledOtp />);
    const boxes = getBoxes();
    // Focus box 0 first so `user.keyboard` fires into it (not the body).
    await user.click(boxes[0]!);
    for (const ch of 'a1b2') {
      await user.keyboard(ch);
    }
    // The final wire value reflects the last keystroke that survived the
    // filter and advanced the focus to box 1.
    const wire = screen.getByTestId('current-value').textContent ?? '';
    // Box 0 ended with the digit the user typed first; box 1 ended with
    // the last digit because focus auto-advanced after it.
    expect(boxes[0]!.value).toBe('1');
    expect(boxes[1]!.value).toBe('2');
    expect(wire).toBe('12');
  });

  it('does not set autoComplete on numeric boxes (preserves the prior surface)', () => {
    render(<ControlledOtp />);
    const boxes = getBoxes();
    for (const box of boxes) {
      expect(box.getAttribute('autocomplete')).toBeNull();
    }
  });
});

describe('OtpInput — alphanumeric mode (BackOffice login)', () => {
  it('renders 6 boxes with inputMode=text and autoComplete=one-time-code on the first box', () => {
    render(<ControlledOtp mode="alphanumeric" />);
    const boxes = getBoxes();
    expect(boxes).toHaveLength(6);
    for (const box of boxes) {
      expect(box).toHaveAttribute('inputmode', 'text');
    }
    expect(boxes[0]).toHaveAttribute('autocomplete', 'one-time-code');
    for (const box of boxes.slice(1)) {
      expect(box.getAttribute('autocomplete')).toBeNull();
    }
  });

  it('forces lowercase letters to uppercase across the 6 boxes', async () => {
    const user = userEvent.setup();
    render(<ControlledOtp mode="alphanumeric" />);
    const boxes = getBoxes();
    await user.type(boxes[0]!, 'a');
    expect(boxes[0]!.value).toBe('A');
    expect(screen.getByTestId('current-value').textContent).toBe('A');
    await user.type(boxes[1]!, 'b');
    await user.type(boxes[2]!, 'c');
    expect(boxes.map((b) => b.value)).toEqual(['A', 'B', 'C', '', '', '']);
  });

  it('accepts both letters and digits but rejects special characters', async () => {
    const user = userEvent.setup();
    render(<ControlledOtp mode="alphanumeric" />);
    const boxes = getBoxes();
    await user.type(boxes[0]!, 'X');
    await user.type(boxes[1]!, '9');
    // '!' is filtered and does NOT auto-advance; the next keystroke still
    // targets the same box.
    await user.type(boxes[2]!, '!');
    await user.type(boxes[2]!, '-');
    await user.type(boxes[3]!, 'Z');
    expect(boxes.map((b) => b.value)).toEqual(['X', '9', '', 'Z', '', '']);
  });

  it('uppercases pasted content and fills multiple boxes from a single paste', async () => {
    const user = userEvent.setup();
    const onLastChange = jest.fn();
    render(<ControlledOtp mode="alphanumeric" onLastChange={onLastChange} />);
    const [first] = getBoxes();
    // user.paste() pastes into the element it is called with; we need to
    // click first so the input is the active element.
    await user.click(first!);
    await user.paste('abcdef');
    expect(onLastChange).toHaveBeenLastCalledWith('ABCDEF');
    expect(screen.getByTestId('current-value').textContent).toBe('ABCDEF');
  });

  it('strips non-alphanumeric characters from pasted content', async () => {
    const user = userEvent.setup();
    const onLastChange = jest.fn();
    render(<ControlledOtp mode="alphanumeric" onLastChange={onLastChange} />);
    const [first] = getBoxes();
    await user.click(first!);
    await user.paste('a-b-1-2!');
    expect(onLastChange).toHaveBeenLastCalledWith('AB12');
    expect(screen.getByTestId('current-value').textContent).toBe('AB12');
  });

  it('renders already-uppercase controlled values as-is (parent contract)', () => {
    render(<ControlledOtp mode="alphanumeric" initial="AB12CD" />);
    const boxes = getBoxes();
    // The contract: parent uppercases before passing `value`. The component
    // renders characters as supplied; the lowercase-to-uppercase enforcement
    // happens at the input boundary (handleChange + handlePaste), not on
    // display.
    expect(boxes.map((b) => b.value)).toEqual(['A', 'B', '1', '2', 'C', 'D']);
  });

  it('respects the `data-testid` prop on the group wrapper', () => {
    render(
      <OtpInput
        mode="alphanumeric"
        value=""
        onChange={() => {}}
        autoFocus={false}
        data-testid="otp-alpha"
      />,
    );
    expect(screen.getByTestId('otp-alpha')).toBeInTheDocument();
  });
});

describe('OtpInput — id pass-through (label association)', () => {
  it('applies the `id` prop to the first box only when provided', () => {
    render(
      <OtpInput
        mode="alphanumeric"
        value=""
        onChange={() => {}}
        autoFocus={false}
        id="otp-1"
      />,
    );
    const boxes = getBoxes();
    expect(boxes[0]).toHaveAttribute('id', 'otp-1');
    for (const box of boxes.slice(1)) {
      expect(box.getAttribute('id')).toBeNull();
    }
  });

  it('omits the `id` attribute on the first box when no `id` prop is provided (default surface unchanged)', () => {
    render(<ControlledOtp mode="alphanumeric" />);
    const boxes = getBoxes();
    for (const box of boxes) {
      expect(box.getAttribute('id')).toBeNull();
    }
  });

  it('lets a paired <label htmlFor> reach the first box via the form (login OTP wiring)', () => {
    render(
      <>
        <label htmlFor="otp-1">Código de acceso</label>
        <OtpInput
          mode="alphanumeric"
          value=""
          onChange={() => {}}
          autoFocus={false}
          id="otp-1"
        />
      </>,
    );
    const firstBox = screen.getByRole('textbox', { name: 'Digit 1 of 6' });
    expect(firstBox).toHaveAttribute('id', 'otp-1');
    // The Label component (or a plain <label htmlFor>) resolves to the
    // same DOM node — a screen reader announces the label text when the
    // first box is focused.
    expect(
      (document.querySelector(`label[for="otp-1"]`) as HTMLLabelElement | null)
        ?.textContent,
    ).toBe('Código de acceso');
  });
});