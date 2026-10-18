import { render, screen } from '@testing-library/react';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { Sidebar } from '@/components/layout/sidebar';
import type { MeResponse } from '@quorum-backoffice/shared';

function renderWith(user: MeResponse, pathname = '/dashboard') {
  return render(
    <PathnameContext.Provider value={pathname}>
      <Sidebar user={user} />
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
});
