import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MarbetesFilters } from '@/app/(authed)/marbetes/_components/marbetes-filters';

const replaceMock = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: replaceMock, refresh: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/marbetes',
}));

describe('MarbetesFilters', () => {
  beforeEach(() => {
    replaceMock.mockClear();
  });

  it('renders status select and search input', () => {
    render(<MarbetesFilters />);
    expect(screen.getByLabelText('Estado')).toBeInTheDocument();
    expect(screen.getByLabelText(/Buscar/i)).toBeInTheDocument();
  });

  it('updates URL search params when status changes', async () => {
    const user = userEvent.setup();
    render(<MarbetesFilters />);
    await user.selectOptions(screen.getByLabelText('Estado'), 'active');
    expect(replaceMock).toHaveBeenCalled();
    const lastCall = replaceMock.mock.calls.at(-1)?.[0] as string;
    expect(lastCall).toMatch(/status=active/);
  });
});
