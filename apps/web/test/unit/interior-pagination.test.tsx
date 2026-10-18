import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Pagination } from '@/components/inventory/pagination';

/**
 * Pagination keeps the maquette shell the table suites read and adds the
 * interior.dev pager: the summary/testids survive, the window is computed by
 * `usePagination`, and every page lives in a fixed-width slot so the bar does
 * not reflow when the number grows.
 */
function renderPager(overrides: Partial<React.ComponentProps<typeof Pagination>> = {}) {
  const onPageChange = jest.fn();
  const onPageSizeChange = jest.fn();
  render(
    <Pagination
      currentPage={1}
      pageSize={10}
      totalItems={95}
      onPageChange={onPageChange}
      onPageSizeChange={onPageSizeChange}
      {...overrides}
    />,
  );
  return { onPageChange, onPageSizeChange };
}

describe('Pagination — interior pager', () => {
  it('keeps the summary and testids', () => {
    renderPager();
    expect(screen.getByTestId('pagination-range')).toHaveTextContent('Mostrando 1–10 de 95');
    expect(screen.getByTestId('pagination-page')).toHaveTextContent('Página 1 de 10');
  });

  it('renders numbered pages and disables the previous arrow on the first page', () => {
    renderPager();
    expect(screen.getByRole('button', { name: 'Página 1' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByTestId('pagination-prev')).toBeDisabled();
    expect(screen.getByTestId('pagination-next')).toBeEnabled();
  });

  it('moves through page numbers and the next arrow', async () => {
    const user = userEvent.setup();
    const { onPageChange } = renderPager();
    await user.click(screen.getByRole('button', { name: 'Página 3' }));
    expect(onPageChange).toHaveBeenLastCalledWith(3);
    await user.click(screen.getByTestId('pagination-next'));
    expect(onPageChange).toHaveBeenLastCalledWith(2);
  });

  it('reports pages of one when every row fits', () => {
    renderPager({ totalItems: 4 });
    expect(screen.getByTestId('pagination-page')).toHaveTextContent('Página 1 de 1');
    expect(screen.getByTestId('pagination-next')).toBeDisabled();
  });
});
