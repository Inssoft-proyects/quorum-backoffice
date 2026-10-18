import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Select } from '@/components/ui/select';

const OPTIONS = [
  { value: '5', label: '5' },
  { value: '10', label: '10' },
  { value: '15', label: '15' },
  { value: 'all', label: 'Todas' },
];

/**
 * Select keeps the native-select-shaped API the pagination expects
 * (`onChange({ target: { value } })`) while behaving as an interior.dev
 * Dropdown: a labelled trigger, a listbox with options, and keyboard
 * selection.
 */
function Harness({ onChange }: { onChange?: (value: string) => void }) {
  const [value, setValue] = useState('10');
  return (
    <div>
      <label htmlFor="inventory-page-size">Filas por página</label>
      <Select
        id="inventory-page-size"
        options={OPTIONS}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          onChange?.(event.target.value);
        }}
      />
      <output data-testid="current">{value}</output>
    </div>
  );
}

describe('Select — interior Dropdown', () => {
  it('exposes the current option through an associated label', () => {
    render(<Harness />);
    const trigger = screen.getByLabelText('Filas por página');
    expect(trigger).toHaveTextContent('10');
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens a listbox and selects an option with the native-shaped event', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByLabelText('Filas por página'));
    const listbox = screen.getByRole('listbox');
    expect(listbox).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'Todas' }));
    expect(onChange).toHaveBeenCalledWith('all');
    expect(screen.getByTestId('current')).toHaveTextContent('all');
  });

  it('closes the list on Escape', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByLabelText('Filas por página'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    // The list unmounts after its exit animation; the observable contract is
    // that the trigger is collapsed again.
    expect(screen.getByLabelText('Filas por página')).toHaveAttribute('aria-expanded', 'false');
  });

  it('does not open when disabled', async () => {
    const user = userEvent.setup();
    render(
      <Select id="s" options={OPTIONS} value="5" disabled onChange={() => {}} aria-label="Filas" />,
    );
    const trigger = screen.getByRole('button', { name: 'Filas' });
    expect(trigger).toBeDisabled();
    await user.click(trigger);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
