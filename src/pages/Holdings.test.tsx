import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { portfolio } from '../test/fixtures';
import { renderPage } from '../test/render';
import { sent, server } from '../test/server';
import { Holdings } from './Holdings';

describe('Holdings page', () => {
  it('lists holdings with live prices, day change and weights', async () => {
    renderPage(<Holdings />);
    const vti = (await screen.findByText('VTI')).closest('tr') as HTMLElement;
    expect(within(vti).getByText('303.00')).toBeInTheDocument(); // live quote
    expect(within(vti).getByText('+$1,500')).toBeInTheDocument(); // 500 units × $3
    expect(within(vti).getByText('+1.00%')).toBeInTheDocument();
    expect(within(vti).getByText('US stocks')).toBeInTheDocument();

    // Mutual funds show the last close and its date.
    const vtiax = screen.getByText('VTIAX').closest('tr') as HTMLElement;
    expect(within(vtiax).getByText('35.20')).toBeInTheDocument();
    expect(within(vtiax).getByText(/Mixed \(International stocks 75%\)/)).toBeInTheDocument();

    // Header total: day change across live-quoted holdings.
    const todays = screen.getByText("Today's change").closest('div') as HTMLElement;
    expect(within(todays).getByText('+$1,500')).toBeInTheDocument();
  });

  it('expands a holding into its accounts and filters by name', async () => {
    const { user } = renderPage(<Holdings />);
    const vti = (await screen.findByText('VTI')).closest('tr') as HTMLElement;
    await user.click(within(vti).getByRole('button', { name: 'Show accounts' }));
    expect(screen.getByText('Roth IRA')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Filter by ticker or name'), 'stable');
    expect(screen.queryByText('VTI')).not.toBeInTheDocument();
    expect(screen.getByText('Insperity 401k Stable Value Trust')).toBeInTheDocument();
  });

  it('flags guessed classifications and saves a correction', async () => {
    const { user } = renderPage(<Holdings />);
    const plan = (await screen.findByText('Insperity 401k Stable Value Trust')).closest('tr') as HTMLElement;
    expect(within(plan).getByText('Review')).toBeInTheDocument();
    await user.click(within(plan).getByRole('button', { name: 'Cash' }));

    const dialog = await screen.findByRole('dialog');
    const cash = within(dialog).getByLabelText('Cash');
    await user.clear(cash);
    await user.type(within(dialog).getByLabelText('US bonds'), '100');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await expect.poll(() => sent('PATCH /api/securities/s-plan').length).toBe(1);
    expect(sent('PATCH /api/securities/s-plan')[0].body).toEqual({ classification: { categories: { us_bond: 1 } } });
  });

  it('works without live quotes', async () => {
    server.use(http.get('*/api/quotes', () => HttpResponse.json({ quotes: [], closes: [] })));
    renderPage(<Holdings />);
    const vti = (await screen.findByText('VTI')).closest('tr') as HTMLElement;
    expect(within(vti).getByText('300.00')).toBeInTheDocument();
    const todays = screen.getByText("Today's change").closest('div') as HTMLElement;
    expect(within(todays).getByText('—')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    server.use(http.get('*/api/portfolio', () => HttpResponse.json({ ...portfolio(), holdings: [] })));
    renderPage(<Holdings />);
    expect(await screen.findByText('No holdings yet')).toBeInTheDocument();
  });
});
