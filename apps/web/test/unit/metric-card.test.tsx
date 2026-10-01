import { render, screen } from '@testing-library/react';
import { MetricCard } from '@/components/inventory/metric-card';

/**
 * MetricCard maquette v2 — the marbetes inventory cards
 * (Total / Disponibles / Asignados / Por atender).
 *
 * The metric-card--with-chart class is applied to all four cards in the
 * canon (see inventario-credenciales.html lines 72-108). The attention
 * card does not render a chart element but still carries the class so the
 * layout reserves the bottom-right space. The filter chip is rendered
 * on every card with the appropriate label per the active state.
 */

describe('MetricCard (maquette v2)', () => {
  it('renders the label + value + meta line', () => {
    render(
      <MetricCard label="Total" value={42} meta="Inventario" onClick={() => {}} />,
    );
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('Inventario')).toBeInTheDocument();
  });

  it('renders the filter chip with "Filtrar" when inactive', () => {
    const { container } = render(
      <MetricCard label="Total" value={42} meta="Inventario" active={false} onClick={() => {}} />,
    );
    const chip = container.querySelector('[data-filter-chip]');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent('Filtrar');
  });

  it('renders the filter chip with "Filtro activo" when active', () => {
    const { container } = render(
      <MetricCard label="Total" value={42} meta="Inventario" active onClick={() => {}} />,
    );
    const chip = container.querySelector('[data-filter-chip]');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent('Filtro activo');
  });

  it('renders the metric-card--with-chart class when chart segments are passed', () => {
    const { container } = render(
      <MetricCard
        label="Total"
        value={42}
        meta="Inventario"
        segments={[{ percent: 50, color: '#000' }, { percent: 50, color: '#fff' }]}
        onClick={() => {}}
      />,
    );
    const root = container.querySelector('button.metric-card');
    expect(root?.classList.contains('metric-card--with-chart')).toBe(true);
  });

  it('still applies metric-card--with-chart when pills are present (canon attention card layout)', () => {
    const { container } = render(
      <MetricCard
        label="Por atender"
        value={5}
        meta="Atención"
        pills={[{ label: '3 próximos', variant: 'warning' }]}
        onClick={() => {}}
      />,
    );
    const root = container.querySelector('button.metric-card');
    expect(root?.classList.contains('metric-card--with-chart')).toBe(true);
    expect(root?.classList.contains('metric-card--attention')).toBe(true);
  });

  it('renders the percentage row with bold "Solo el " prefix and a descriptive aria-label', () => {
    render(
      <MetricCard
        label="Por atender"
        value={5}
        meta="Atención"
        percentageLabel="2% del total"
        percentageAriaLabel="2% del inventario requiere atención"
        pills={[{ label: '3 próximos', variant: 'warning' }]}
        onClick={() => {}}
      />,
    );
    const percentage = screen.getByText(/2% del total/);
    expect(percentage.parentElement?.querySelector('b')?.textContent).toBe('Solo el ');
    // The aria-label should describe the data meaning, not just
    // mirror the visible text — canon ships a more informative label.
    expect(percentage.getAttribute('aria-label')).toBe('2% del inventario requiere atención');
  });

  it('reflects the active state via aria-pressed', () => {
    const { rerender } = render(
      <MetricCard label="Total" value={42} meta="Inventario" active={false} onClick={() => {}} />,
    );
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'false');
    rerender(
      <MetricCard label="Total" value={42} meta="Inventario" active onClick={() => {}} />,
    );
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  });
});