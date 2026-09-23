import { render, screen } from '@testing-library/react';
import { Sidebar } from '@/components/layout/sidebar';
import type { MeResponse } from '@quorum-backoffice/shared';

function renderWith(user: MeResponse) {
  return render(<Sidebar user={user} />);
}

describe('Sidebar', () => {
  it('renders Marbetes and Dispositivos for any role', () => {
    renderWith({ id: 1, email: 'op@example.com', role: 'operator' });
    expect(screen.getByText('Marbetes')).toBeInTheDocument();
    expect(screen.getByText('Dispositivos')).toBeInTheDocument();
  });

  it('renders Auditoría for auditor role', () => {
    renderWith({ id: 1, email: 'aud@example.com', role: 'auditor' });
    expect(screen.getByText('Auditoría')).toBeInTheDocument();
  });

  it('renders Auditoría for admin role', () => {
    renderWith({ id: 1, email: 'adm@example.com', role: 'admin' });
    expect(screen.getByText('Auditoría')).toBeInTheDocument();
  });

  it('hides Auditoría for operator role', () => {
    renderWith({ id: 1, email: 'op@example.com', role: 'operator' });
    expect(screen.queryByText('Auditoría')).toBeNull();
  });
});