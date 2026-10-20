import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { Sidebar } from '@/components/layout/sidebar';
import type { MeResponse } from '@quorum-backoffice/shared';

function renderWith(
  user: MeResponse,
  pathname = '/dashboard',
  props: { collapsed?: boolean; onToggle?: () => void } = {},
) {
  return render(
    <PathnameContext.Provider value={pathname}>
      <Sidebar user={user} {...props} />
    </PathnameContext.Provider>,
  );
}

describe('Sidebar', () => {
  it('renders Marbetes and Dispositivos for any role', () => {
    renderWith({ id: 1, username: null, email: 'op@example.com', role: 'operator' });
    expect(screen.getByText('Marbetes')).toBeInTheDocument();
    expect(screen.getByText('Asignación de marbetes')).toBeInTheDocument();
    expect(screen.getByText('Dispositivos')).toBeInTheDocument();
  });

  it('renders Auditoría for auditor role', () => {
    renderWith({ id: 1, username: null, email: 'aud@example.com', role: 'auditor' });
    expect(screen.getByText('Auditoría')).toBeInTheDocument();
  });

  it('renders Auditoría for admin role', () => {
    renderWith({ id: 1, username: null, email: 'adm@example.com', role: 'admin' });
    expect(screen.getByText('Auditoría')).toBeInTheDocument();
  });

  it('hides Auditoría for operator role', () => {
    renderWith({ id: 1, username: null, email: 'op@example.com', role: 'operator' });
    expect(screen.queryByText('Auditoría')).toBeNull();
  });

  it('marks the current route with aria-current and a primary tint', () => {
    renderWith({ id: 1, username: null, email: 'op@example.com', role: 'operator' }, '/marbetes');
    const active = screen.getByText('Marbetes').closest('a');
    expect(active).toHaveAttribute('aria-current', 'page');
    expect(active?.className).toContain('text-primary-600');
    expect(screen.getByText('Dispositivos').closest('a')).not.toHaveAttribute('aria-current');
  });

  it('shows the INEC Conecta mark and the BackOffice title', () => {
    renderWith({ id: 1, username: null, email: 'adm@example.com', role: 'admin' });
    expect(screen.getByRole('img', { name: 'INEC Conecta' })).toBeInTheDocument();
    expect(screen.getByText('BackOffice')).toBeInTheDocument();
    expect(screen.queryByText('Quorum Backoffice')).toBeNull();
  });

  it('renders the collapse toggle only when the shell wires it', async () => {
    const onToggle = jest.fn();
    renderWith({ id: 1, username: null, email: 'adm@example.com', role: 'admin' }, '/dashboard', {
      onToggle,
    });

    const toggle = screen.getByTestId('sidebar-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAccessibleName('Contraer barra lateral');

    await userEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('keeps every nav label reachable when collapsed to the icon rail', () => {
    renderWith({ id: 1, username: null, email: 'adm@example.com', role: 'admin' }, '/marbetes', {
      collapsed: true,
      onToggle: jest.fn(),
    });

    // The labels survive as accessible names, and the rail advertises them
    // through `title` so a mouse user still sees the tooltip.
    for (const label of [
      'Inicio',
      'Marbetes',
      'Asignación de marbetes',
      'Dispositivos',
      'Auditoría',
    ]) {
      const link = screen.getByRole('link', { name: label });
      expect(link).toHaveAttribute('title', label);
    }
    expect(screen.getByTestId('sidebar-toggle')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('sidebar-toggle')).toHaveAccessibleName('Expandir barra lateral');
    expect(screen.getByText('BackOffice')).toBeInTheDocument();
  });
});
