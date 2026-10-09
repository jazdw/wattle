import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { renderPage } from '../test/render';
import { sent, server } from '../test/server';
import { NetWorth } from './NetWorth';

describe('Net worth page', () => {
  it('shows the total, change, assets and liabilities', async () => {
    renderPage(<NetWorth />);
    expect(await screen.findByText('$1,366,200')).toBeInTheDocument();
    expect(screen.getByText(/\+\$66,200/)).toBeInTheDocument(); // first → last point of the 1Y history
    expect(screen.getByText('$1,368,500')).toBeInTheDocument();
    expect(screen.getByText('-$2,300', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText(/reconstructed from transactions/)).toBeInTheDocument();
  });

  it('groups visible accounts by type with owner badges', async () => {
    renderPage(<NetWorth />);
    const cash = (await screen.findByText('Cash')).closest('div.rounded-lg') as HTMLElement;
    expect(within(cash).getByText('Chase Checking')).toBeInTheDocument();
    expect(within(cash).getByText('··1234')).toBeInTheDocument();
    expect(within(cash).getByText('Westpac Everyday')).toBeInTheDocument();
    expect(within(cash).getByText('AUD')).toBeInTheDocument();

    const investments = screen.getByText('Investments').closest('div.rounded-lg') as HTMLElement;
    expect(within(investments).getByText('Joint')).toBeInTheDocument();
    expect(within(investments).getByText('Sam')).toBeInTheDocument();

    // Hidden accounts never show.
    expect(screen.queryByText('Joint IRA copy')).not.toBeInTheDocument();
  });

  it('warns about broken connections', async () => {
    renderPage(<NetWorth />);
    expect(await screen.findByText(/Vanguard needs attention/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Fix in Accounts' })).toHaveAttribute('href', '/accounts');
  });

  it('changes the range and refreshes', async () => {
    const { user } = renderPage(<NetWorth />);
    await screen.findByText('$1,366,200');
    await user.click(screen.getByRole('tab', { name: '3M' }));
    expect(await screen.findByText('past 3M')).toBeInTheDocument();
    expect(sent('GET /api/history').some((request) => request.url.searchParams.get('range') === '3M')).toBe(true);

    await user.click(screen.getByRole('button', { name: /Refresh/ }));
    await expect.poll(() => sent('POST /api/refresh').length).toBe(1);
  });

  it('shows an empty state with no accounts', async () => {
    server.use(http.get('*/api/accounts', () => HttpResponse.json({ accounts: [] })));
    renderPage(<NetWorth />);
    expect(await screen.findByText('No accounts yet')).toBeInTheDocument();
  });

  it('explains when there is no history yet', async () => {
    server.use(http.get('*/api/history', () => HttpResponse.json({ currency: 'USD', group: 'total', dates: [], series: [], estimated: [] })));
    renderPage(<NetWorth />);
    expect(await screen.findByText(/History builds up/)).toBeInTheDocument();
  });
});
