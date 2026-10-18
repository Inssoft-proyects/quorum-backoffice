import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '@/components/ui/button';

/**
 * Button keeps the shadcn contract (variant/size/disabled/onClick) while
 * adding the two interior.dev mechanisms: press depth and a reserved-width
 * pending face. These tests pin the observable behaviour that consumers and
 * RTL suites depend on:
 *
 *   - the idle accessible name never grows because a pending face exists;
 *   - `loading` marks the control aria-busy and swaps the exposed label;
 *   - the pending label is present in the DOM from mount when `loadingLabel`
 *     is supplied (that presence is what reserves the width);
 *   - clicking still calls the caller's handler exactly once, and a disabled
 *     button does not.
 */
describe('Button — interior Press Depth + Loading Button', () => {
  it('exposes only the idle label when no loading label is reserved', () => {
    render(<Button>Guardar</Button>);
    const button = screen.getByRole('button', { name: 'Guardar' });
    expect(button).not.toHaveAttribute('aria-busy');
  });

  it('reserves the pending face from mount without changing the accessible name', () => {
    render(<Button loadingLabel="Guardando…">Guardar</Button>);
    const button = screen.getByRole('button', { name: 'Guardar' });
    // The pending copy is laid out (invisible) so the width is reserved
    // before the state is ever reached.
    expect(button).toHaveTextContent('Guardando…');
    expect(button).not.toHaveAttribute('aria-busy');
  });

  it('marks the button busy and exposes the pending label while loading', () => {
    render(
      <Button loading loadingLabel="Guardando…">
        Guardar
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Guardando…' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveTextContent('Guardar');
  });

  it('calls onClick once per click and not at all when disabled', async () => {
    const user = userEvent.setup();
    const onClick = jest.fn();
    const { rerender } = render(<Button onClick={onClick}>Guardar</Button>);
    await user.click(screen.getByRole('button', { name: 'Guardar' }));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <Button onClick={onClick} disabled>
        Guardar
      </Button>,
    );
    await user.click(screen.getByRole('button', { name: 'Guardar' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('keeps variant and size classes on the outer control', () => {
    render(
      <Button variant="destructive" size="sm" className="w-full">
        Eliminar
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Eliminar' });
    expect(button.className).toContain('bg-alert-error-text');
    expect(button.className).toContain('h-9');
    expect(button.className).toContain('w-full');
  });
});
