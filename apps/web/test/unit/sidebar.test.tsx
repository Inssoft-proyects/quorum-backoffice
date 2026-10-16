import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Sidebar } from '@/components/layout/sidebar';
import type { MeResponse } from '@quorum-backoffice/shared';

const mockPush = jest.fn();
const mockLogout = jest.fn().mockResolvedValue(undefined);

jest.mock('next/navigation', () => ({
  usePathname: () => '/backoffice/marbetes',
  useRouter: () => ({ push: mockPush }),
}));
jest.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ logout: mockLogout }),
}));

function renderWith(user: MeResponse) {
  return render(<Sidebar user={user} />);
}

describe('Sidebar', () => {
  it('renders Marbetes and Dispositivos for any role', () => {
    renderWith({ id: 1, email: 'op@example.com', role: 'operator' });
    expect(screen.getByText('Marbetes')).toBeInTheDocument();
    expect(screen.getByText('Asignación de marbetes')).toBeInTheDocument();
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

  it('highlights the current route without a menu search', () => {
    renderWith({ id: 1, email: 'adm@example.com', role: 'admin' });
    expect(screen.getByRole('link', { name: 'Marbetes' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.getByRole('link', { name: 'Auditoría' })).toBeInTheDocument();
  });

  it('places Salir after the navigation in a separate footer', () => {
    renderWith({ id: 1, email: 'adm@example.com', role: 'admin' });
    const nav = screen.getByRole('navigation', { name: 'Navegación principal' });
    const footer = screen.getByTestId('sidebar-footer');
    expect(nav.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(footer.querySelector('button')).toHaveAccessibleName('Salir');
  });

  it('can collapse and expand without losing accessible route names', () => {
    renderWith({ id: 1, email: 'adm@example.com', role: 'admin' });
    fireEvent.click(screen.getByRole('button', { name: 'Contraer menú' }));
    expect(screen.getByTestId('sidebar')).toHaveAttribute('data-compact', 'true');
    expect(screen.getByRole('link', { name: 'Marbetes' })).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-footer').querySelector('button')).toHaveAccessibleName('Salir');
    fireEvent.click(screen.getByRole('button', { name: 'Expandir menú' }));
    expect(screen.getByTestId('sidebar')).toHaveAttribute('data-compact', 'false');
  });

  it('uses the existing logout flow and returns to Acceso', async () => {
    mockPush.mockClear();
    mockLogout.mockClear();
    renderWith({ id: 1, email: 'adm@example.com', role: 'admin' });
    fireEvent.click(screen.getByTestId('sidebar-footer').querySelector('button')!);
    await waitFor(() => expect(mockLogout).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/login'));
  });
});
