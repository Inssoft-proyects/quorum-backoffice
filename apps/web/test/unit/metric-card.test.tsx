import { render, screen } from '@testing-library/react';
import { MetricCard } from '@/components/inventory/metric-card';

/**
 * MetricCard maquette v3 — the marbetes / dispositivos / auditoría
 * inventory cards (Total / Disponibles / Asignados / Por atender).
 *
 * The donut was replaced by a compact proportional bar (metric-bar) so
 * the card can stay on a single, small geometry shared by every screen.
 * The card is a CSS grid with explicit areas (label / chip / value /
 * ratio / meta / bar); see `.metric-card` in globals.css. The filter
 * chip is a static grid-area item — no absolute positioning — and the
 * label is single-line with `text-overflow: ellipsis` plus a `title`
 * attribute carrying the full text. The e2e and unit suites rely on
 * `aria-pressed={active}`, `data-filter={label.toLowerCase()}` and the
 * preserved `data-testid` passthrough, so they MUST stay byte-identical.
 */

describe('MetricCard (maquette v3)', () => {
  it('renders the label + value + meta line', () => {
    render(<MetricCard label="Total" value={42} meta="Inventario" onClick={() => {}} />);
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

  it('keeps the label on a single line and exposes the full text via `title`', () => {
    const { container } = render(
      <MetricCard
        label="Etiqueta muy larga que de otra forma se desbordaría"
        value={42}
        meta="Inventario"
        onClick={() => {}}
      />,
    );
    const label = container.querySelector('.metric-card__label');
    expect(label).toBeInTheDocument();
    expect(label).toHaveAttribute('title', 'Etiqueta muy larga que de otra forma se desbordaría');
    // The grid setup relies on the label being a single line — the
    // CSS does the ellipsis but JSX must NOT introduce a wrapping
    // element between the text node and `.metric-card__label`.
    expect(label?.childElementCount ?? 0).toBe(0);
  });

  it('forwards data-testid / data-filter / aria-pressed on the root button', () => {
    const { rerender } = render(
      <MetricCard
        label="Total"
        value={42}
        meta="Inventario"
        active={false}
        data-testid="dashboard-card-total"
        onClick={() => {}}
      />,
    );
    const root = screen.getByTestId('dashboard-card-total');
    expect(root).toHaveAttribute('data-filter', 'total');
    expect(root).toHaveAttribute('aria-pressed', 'false');

    rerender(
      <MetricCard
        label="Total"
        value={42}
        meta="Inventario"
        active
        data-testid="dashboard-card-total"
        onClick={() => {}}
      />,
    );
    expect(screen.getByTestId('dashboard-card-total')).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders one bar segment per `segments` entry with width and accessible label', () => {
    const { container } = render(
      <MetricCard
        label="Total"
        value={42}
        meta="Inventario"
        segments={[
          { percent: 40, color: 'rgb(53, 132, 86)' },
          { percent: 30, color: 'rgb(39, 86, 111)' },
          { percent: 30, color: 'rgb(171, 134, 32)' },
        ]}
        onClick={() => {}}
      />,
    );
    const bar = container.querySelector('.metric-bar[role="img"]');
    expect(bar).toBeInTheDocument();
    // The spec wires the bar's `aria-label` to the card's `label` prop.
    expect(bar).toHaveAttribute('aria-label', 'Total');
    const segsByClass = bar?.querySelectorAll('.metric-bar__seg') ?? [];
    expect(segsByClass).toHaveLength(3);
    expect(segsByClass[0]).toHaveStyle({ width: '40%', background: 'rgb(53, 132, 86)' });
    expect(segsByClass[1]).toHaveStyle({ width: '30%', background: 'rgb(39, 86, 111)' });
    expect(segsByClass[2]).toHaveStyle({ width: '30%', background: 'rgb(171, 134, 32)' });
  });

  it('omits the bar when neither `segments` nor `ratio` is given', () => {
    const { container } = render(
      <MetricCard label="Total" value={42} meta="Inventario" onClick={() => {}} />,
    );
    expect(container.querySelector('.metric-bar')).not.toBeInTheDocument();
  });

  it('renders a single segment from `ratio` alone, using the default token', () => {
    const { container } = render(
      <MetricCard label="Total" value={42} meta="Inventario" ratio={73} onClick={() => {}} />,
    );
    const segs = container.querySelectorAll('.metric-bar__seg');
    expect(segs).toHaveLength(1);
    expect(segs[0]).toHaveStyle({ width: '73%' });
    expect(container.querySelector('.metric-bar')).toHaveAttribute('aria-label', 'Total');
  });

  it('renders the pills row on the attention card', () => {
    const { container } = render(
      <MetricCard
        label="Por atender"
        value={5}
        meta="Atención"
        pills={[
          { label: '3 próximos', variant: 'warning' },
          { label: '2 vencidos', variant: 'danger' },
        ]}
        onClick={() => {}}
      />,
    );
    const root = container.querySelector('button.metric-card');
    expect(root?.classList.contains('metric-card--attention')).toBe(true);
    const meta = container.querySelector('.metric-card__meta');
    expect(meta).toBeInTheDocument();
    expect(meta).toHaveTextContent('3 próximos');
    expect(meta).toHaveTextContent('2 vencidos');
    const pills = container.querySelectorAll('.metric-card__meta-pill');
    expect(pills).toHaveLength(2);
    expect(pills[0]).toHaveTextContent('3 próximos');
    expect(pills[1]).toHaveTextContent('2 vencidos');
  });

  it('renders `ratioLabel` next to the value as a small bold label', () => {
    const { container } = render(
      <MetricCard label="Activos" value={120} meta="En uso" ratioLabel="65%" onClick={() => {}} />,
    );
    const ratio = container.querySelector('.metric-card__ratio');
    expect(ratio).toBeInTheDocument();
    expect(ratio).toHaveTextContent('65%');
  });

  it('renders the attention-card `percentageLabel` with the "Solo el " prefix and a different aria-label', () => {
    // The dashboard’s attention card (a.k.a. "Por atender") pairs
    // a `ratio` (drives the bar) with a `percentageLabel` (the visible
    // share text) — the bar and the ratio share the card surface.
    const { container } = render(
      <MetricCard
        label="Por atender"
        value={5}
        meta="Atención"
        ratio={2}
        percentageLabel="2% del total"
        percentageAriaLabel="2% del inventario requiere atención"
        pills={[{ label: '3 próximos', variant: 'warning' }]}
        onClick={() => {}}
      />,
    );
    const percentage = container.querySelector('.metric-card__ratio');
    expect(percentage).toHaveTextContent(/2% del total/);
    expect(percentage?.querySelector('b')?.textContent).toBe('Solo el ');
    expect(percentage).toHaveAttribute('aria-label', '2% del inventario requiere atención');
    // The bar is also rendered (driven by `ratio`, not by an explicit
    // `segments` array).
    const bar = container.querySelector('.metric-bar');
    expect(bar).toBeInTheDocument();
    const segs = container.querySelectorAll('.metric-bar__seg');
    expect(segs).toHaveLength(1);
    expect(segs[0]).toHaveStyle({ width: '2%' });
  });
});
