import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

/**
 * Alert keeps the shadcn surface (`variant`, `role`, testids, title and
 * description) while adopting interior.dev's Collapsible Banner mechanics:
 * the body can fold behind a title, the dismissal is announced politely, and
 * a plain message-only alert never grows a fold control it did not ask for.
 */
describe('Alert — interior Collapsible Banner', () => {
  it('keeps the plain message form unchanged', () => {
    render(
      <Alert variant="destructive" role="alert" data-testid="err">
        Código OTP inválido
      </Alert>,
    );
    const alert = screen.getByTestId('err');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('Código OTP inválido');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('folds and unfolds when a title is provided', async () => {
    const user = userEvent.setup();
    render(
      <Alert variant="warning" title="Faltan datos" data-testid="warn">
        <AlertDescription>Revisa el formulario.</AlertDescription>
      </Alert>,
    );
    const toggle = screen.getByRole('button', { name: /Faltan datos/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('announces a dismissal when dismissible', async () => {
    const user = userEvent.setup();
    const onDismiss = jest.fn();
    render(
      <Alert variant="success" dismissible onDismiss={onDismiss} data-testid="ok">
        Acceso concedido
      </Alert>,
    );
    await user.click(screen.getByRole('button', { name: 'Descartar aviso' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('Aviso descartado.');
  });

  it('renders AlertTitle and AlertDescription', () => {
    render(
      <Alert>
        <AlertTitle>Encabezado</AlertTitle>
        <AlertDescription>Detalle</AlertDescription>
      </Alert>,
    );
    expect(screen.getByText('Encabezado')).toBeInTheDocument();
    expect(screen.getByText('Detalle')).toBeInTheDocument();
  });
});
