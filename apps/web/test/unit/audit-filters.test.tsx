import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuditFilters } from '@/app/(authed)/audit/_components/audit-filters';

const replaceMock = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: replaceMock, refresh: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/audit',
}));

describe('AuditFilters', () => {
  beforeEach(() => {
    replaceMock.mockClear();
  });

  it('renders all filter controls', () => {
    render(<AuditFilters />);
    expect(screen.getByTestId('audit-filters')).toBeInTheDocument();
    expect(screen.getByLabelText(/Tipo de entidad/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Acción/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Actor ID/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Desde/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Hasta/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Búsqueda libre/i)).toBeInTheDocument();
  });

  it('updates URL when entityType changes', async () => {
    const user = userEvent.setup();
    render(<AuditFilters />);
    await user.selectOptions(screen.getByTestId('filter-entity-type'), 'marbete');
    expect(replaceMock).toHaveBeenCalled();
    const lastCall = replaceMock.mock.calls.at(-1)?.[0] as string;
    expect(lastCall).toMatch(/entityType=marbete/);
  });
});