import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import type { AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { LoginForm } from '@/app/login/login-form';
import { AuthProvider } from '@/lib/auth-context';
import type { ReactNode } from 'react';

const stubRouter: AppRouterInstance = {
  back: () => undefined,
  forward: () => undefined,
  refresh: () => undefined,
  push: () => undefined,
  replace: () => undefined,
  prefetch: () => undefined,
};

function withRouter(children: ReactNode) {
  return (
    <AppRouterContext.Provider value={stubRouter}>{children}</AppRouterContext.Provider>
  );
}

function renderForm() {
  return render(
    withRouter(
      <AuthProvider>
        <LoginForm />
      </AuthProvider>,
    ),
  );
}

describe('LoginForm', () => {
  it('renders email and password fields with submit button disabled until valid', () => {
    renderForm();
    const email = screen.getByLabelText('Correo') as HTMLInputElement;
    const password = screen.getByLabelText('Contraseña') as HTMLInputElement;
    const button = screen.getByRole('button', { name: /Ingresar/i }) as HTMLButtonElement;
    expect(email).toBeInTheDocument();
    expect(password).toBeInTheDocument();
    expect(button).toBeDisabled();
  });

  it('shows error when login fails with invalid credentials', async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response(JSON.stringify({ code: 'invalid_credentials', message: 'invalid email or password' }), {
        status: 401,
      })) as unknown as typeof fetch;
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText('Correo'), 'wrong@example.com');
    await user.type(screen.getByLabelText('Contraseña'), 'wrongpass');
    await user.click(screen.getByRole('button', { name: /Ingresar/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/incorrectos/i);
    });
  });
});