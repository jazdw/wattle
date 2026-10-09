import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { emptyCategoryTotals } from '../../shared/allocation';
import { portfolio } from '../test/fixtures';
import { renderPage } from '../test/render';
import { sent, server } from '../test/server';
import { Allocation } from './Allocation';

function row(name: string) {
  return screen.getByRole('row', { name: new RegExp(`^${name}`) });
}

describe('Allocation page', () => {
  it('compares each category with the target and flags drift', async () => {
    renderPage(<Allocation />);
    expect(await screen.findByRole('row', { name: /^US stocks/ })).toBeInTheDocument();
    const us = row('US stocks');
    expect(within(us).getByText('$150,000')).toBeInTheDocument();
    expect(within(us).getByText('50.0%')).toBeInTheDocument(); // target
    expect(within(us).getByText('Outside band')).toBeInTheDocument();
    expect(within(row('Emerging markets')).queryByText('Outside band')).not.toBeInTheDocument();
    // Targeted but not held.
    expect(within(row('US bonds')).getByText('$0')).toBeInTheDocument();
  });

  it('suggests buys for new cash, and buys/sells for a full rebalance', async () => {
    const { user } = renderPage(<Allocation />);
    const amount = await screen.findByRole('textbox', { name: 'Amount to invest' });
    await user.clear(amount);
    await user.type(amount, '20000');
    const buys = screen.getAllByText(/^Buy /).map((element) => element.textContent);
    expect(buys).toContain('Buy US stocks');
    expect(screen.queryByText(/^Sell /)).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Full rebalance' }));
    expect(screen.getByText('Sell Australian stocks')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Amount to invest' })).not.toBeInTheDocument();
  });

  it('edits and saves the target as fractions', async () => {
    const { user } = renderPage(<Allocation />);
    await user.click(await screen.findByRole('button', { name: /Edit target/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Target allocation' });
    expect(within(dialog).getByText('Total 100.0%')).toBeInTheDocument();

    const us = within(dialog).getByLabelText('US stocks');
    await user.clear(us);
    await user.type(us, '45');
    expect(within(dialog).getByText('Total 95.0%')).toBeInTheDocument();
    const intlBonds = within(dialog).getByLabelText('International bonds');
    await user.type(intlBonds, '5');
    await user.click(within(dialog).getByRole('switch', { name: /Cash/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Save target' }));

    await expect.poll(() => sent('PUT /api/targets').length).toBe(1);
    const body = sent('PUT /api/targets')[0].body as { weights: Record<string, number>; excludedCategories: string[] };
    expect(body.weights.us_stock).toBeCloseTo(0.45);
    expect(body.weights.intl_bond).toBeCloseTo(0.05);
    expect(body.excludedCategories).toEqual(['real_estate', 'cash']);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('invites setting a target when none exists', async () => {
    server.use(http.get('*/api/targets', () => HttpResponse.json({ target: null })));
    renderPage(<Allocation />);
    expect(await screen.findByText('No target set')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Set a target/ })).toBeInTheDocument();
    expect(screen.queryByText('Rebalance')).not.toBeInTheDocument();
  });

  it('shows an empty state before anything is invested', async () => {
    const empty = { ...portfolio(), categories: emptyCategoryTotals(), holdings: [] };
    server.use(http.get('*/api/portfolio', () => HttpResponse.json(empty)));
    renderPage(<Allocation />);
    expect(await screen.findByText('Nothing to allocate yet')).toBeInTheDocument();
  });
});
