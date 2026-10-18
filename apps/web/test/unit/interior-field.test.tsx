import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Field } from '@/components/ui/field';

/**
 * Field pins the interior.dev Floating Label contract that the forms rely on:
 * the visible label is the accessible name, the hint row exists before the
 * hint does (so nothing below moves), a placeholder only appears once the
 * label has been raised, and the controlled value reaches the caller as a
 * string.
 */
function Controlled({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <Field
        id="correo"
        label="Correo"
        type="email"
        value={value}
        onChange={setValue}
        hint="Recibe avisos aquí."
        placeholder="admin@quorum.local"
        data-testid="correo-input"
      />
      <output data-testid="current">{value}</output>
    </>
  );
}

describe('Field — interior Floating Label', () => {
  it('associates the visible label with the input', () => {
    render(<Controlled />);
    const input = screen.getByLabelText('Correo');
    expect(input).toHaveAttribute('id', 'correo');
    expect(input).toHaveAttribute('data-testid', 'correo-input');
  });

  it('wires the hint through aria-describedby once', () => {
    render(<Controlled />);
    const input = screen.getByLabelText('Correo');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent('Recibe avisos aquí.');
  });

  it('hides the placeholder until the field is focused', async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    const input = screen.getByLabelText('Correo');
    expect(input.getAttribute('placeholder')).toBeNull();
    await user.click(input);
    expect(input).toHaveAttribute('placeholder', 'admin@quorum.local');
  });

  it('reports the typed value to the caller', async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    await user.type(screen.getByLabelText('Correo'), 'a@b.mx');
    expect(screen.getByTestId('current')).toHaveTextContent('a@b.mx');
  });

  it('keeps a raised label for a value supplied at mount', () => {
    render(<Controlled initial="prellenado@quorum.mx" />);
    const input = screen.getByLabelText('Correo') as HTMLInputElement;
    expect(input.value).toBe('prellenado@quorum.mx');
  });

  it('marks the field invalid for assistive tech', () => {
    render(<Field id="serial" label="Serial" value="" onChange={() => {}} invalid />);
    const input = screen.getByLabelText('Serial');
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });
});
