import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { portfolio, QUOTES } from '../test/fixtures';
import { renderPage } from '../test/render';
import { sent, server } from '../test/server';
import { isLiveQuote } from '../hooks/queries';
import { Holdings } from './Holdings';

describe('Holdings page', () => {
  it('lists holdings with live prices, day change and weights', async () => {
    renderPage(<Holdings />);
    const vti = (await screen.findByText('VTI')).closest('tr') as HTMLElement;
    expect(within(vti).getByText('$303.00')).toBeInTheDocument(); // live quote
    expect(within(vti).getByText('$1,500.00')).toBeInTheDocument(); // 500 units × $3
    expect(within(vti).getByText('1.00%')).toBeInTheDocument();
    // When its quote was last updated, under the price.
    expect(within(vti).getByLabelText('Live')).toBeInTheDocument(); // ((o)) on live rows
    expect(within(vti).getByTitle(/^Live price, last updated /)).toHaveTextContent(new Date(QUOTES.quotes[0].time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    expect(within(vti).getByText('US stocks')).toBeInTheDocument();

    // Mutual funds show the last close and its date.
    const vtiax = screen.getByText('VTIAX').closest('tr') as HTMLElement;
    expect(within(vtiax).getByText('$35.20')).toBeInTheDocument();
    expect(within(vtiax).getByText(/Mixed \(International stocks 75%\)/)).toBeInTheDocument();
    expect(within(vtiax).queryByLabelText('Live')).not.toBeInTheDocument(); // a last close isn't live
    expect(within(vti).getByText('ETF')).toBeInTheDocument(); // type beside the ticker
    expect(within(vtiax).getByText('Mutual fund')).toBeInTheDocument();
    expect(within(vtiax).getByTitle(/^Net asset value on /)).toHaveTextContent(/ \(NAV\)$/); // a fund's price is its NAV

    // Header total: day change across live-quoted holdings.
    const todays = screen.getByText("Today's change").closest('div') as HTMLElement;
    expect(within(todays).getByText('$1,500.00')).toBeInTheDocument();
    // …and as a share of the holdings' value at the previous close.
    // No "+" on gains (the colour shows it); losses keep their "-".
    expect(within(todays).getByText(/^\(-?\d+\.\d{2}%\)$/)).toBeInTheDocument();
  });

  it('expands a holding into its accounts and filters by name', async () => {
    const { user } = renderPage(<Holdings />);
    const vti = (await screen.findByText('VTI')).closest('tr') as HTMLElement;
    await user.click(within(vti).getByRole('button', { name: 'Show accounts' }));
    expect(screen.getByText('Roth IRA')).toBeInTheDocument();
    // Each account: live value and the day's dollar change (VTI +$3 a unit), adding up to the row above.
    const brokerage = screen.getByText('Vanguard Brokerage').closest('tr') as HTMLElement;
    expect(within(brokerage).getByText('$1,200.00')).toBeInTheDocument();
    expect(within(brokerage).getByText('$121,200.00')).toBeInTheDocument();
    const ira = screen.getByText('Roth IRA').closest('tr') as HTMLElement;
    expect(within(ira).getByText('$300.00')).toBeInTheDocument();
    expect(within(ira).getByText('$30,300.00')).toBeInTheDocument();
    expect(within(ira).queryByText(/%/)).not.toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Filter by ticker or name'), 'stable');
    expect(screen.queryByText('VTI')).not.toBeInTheDocument();
    expect(screen.getByText('Example 401k Stable Value Trust')).toBeInTheDocument();
  });

  it('flags guessed classifications and saves a correction', async () => {
    const { user } = renderPage(<Holdings />);
    const plan = (await screen.findByText('Example 401k Stable Value Trust')).closest('tr') as HTMLElement;
    expect(within(plan).getByRole('button', { name: 'Cash' })).toBeInTheDocument(); // the category opens the editor too
    await user.click(within(plan).getByRole('button', { name: 'Review classification' }));

    const dialog = await screen.findByRole('dialog');
    const cash = within(dialog).getByLabelText('Cash');
    await user.clear(cash);
    await user.type(within(dialog).getByLabelText('US bonds'), '100');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await expect.poll(() => sent('PATCH /api/securities/s-plan').length).toBe(1);
    expect(sent('PATCH /api/securities/s-plan')[0].body).toEqual({ classification: { categories: { us_bond: 1 } } });
  });

  it('lets you set the type of a security you entered', async () => {
    server.use(
      http.get('*/api/portfolio', () =>
        HttpResponse.json({ ...portfolio(), holdings: portfolio().holdings.map((row) => (row.ticker === 'VTI' ? { ...row, typeEditable: true } : row)) }),
      ),
    );
    const { user } = renderPage(<Holdings />);
    const vti = (await screen.findByText('VTI')).closest('tr') as HTMLElement;
    await user.click(within(vti).getByRole('button', { name: 'US stocks' }));
    const dialog = await screen.findByRole('dialog', { name: /^Classify VTI/ });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: /^Type/ }), 'Mutual fund');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await expect.poll(() => (sent('PATCH /api/securities/s-vti')[0]?.body as { type?: string })?.type).toBe('mutual fund');
  });

  it('counts a quote as live for 15 minutes after its last update', () => {
    const now = Date.parse('2026-10-19T15:00:00Z');
    expect(isLiveQuote({ time: now - 14 * 60_000 }, now)).toBe(true);
    expect(isLiveQuote({ time: now - 15 * 60_000 }, now)).toBe(false);
  });

  it("shows today's price after the close, but not as live", async () => {
    const closed = Date.now() - 20 * 60_000; // last updated 20 minutes ago
    server.use(http.get('*/api/quotes', () => HttpResponse.json({ ...QUOTES, quotes: QUOTES.quotes.map((quote) => ({ ...quote, time: closed })) })));
    renderPage(<Holdings />);
    const vti = (await screen.findByText('VTI')).closest('tr') as HTMLElement;
    expect(within(vti).getByText('$303.00')).toBeInTheDocument();
    expect(within(vti).getByTitle(/^Price, last updated /)).toBeInTheDocument();
    expect(screen.queryByLabelText('Live')).not.toBeInTheDocument();
    expect(screen.getByText('Total value')).toBeInTheDocument();
    const todays = screen.getByText("Today's change").closest('div') as HTMLElement;
    expect(within(todays).getByText('$1,500.00')).toBeInTheDocument(); // today's change still shown
  });

  it("identifies a bond without a ticker by its CUSIP", async () => {
    server.use(
      http.get('*/api/portfolio', () =>
        HttpResponse.json({
          ...portfolio(),
          holdings: [
            ...portfolio().holdings,
            { ...portfolio().holdings[0], securityId: 's-bill', ticker: null, cusip: '912797GZ4', name: 'United States Treas Bills 0.000% 10/31/24', type: 'fixed income' },
          ],
        }),
      ),
    );
    renderPage(<Holdings />);
    const bill = (await screen.findByText('912797GZ4')).closest('tr') as HTMLElement;
    expect(within(bill).getByTitle('CUSIP')).toBeInTheDocument();
    expect(within(bill).getByText('Bond')).toBeInTheDocument();
  });

  it('works without live quotes', async () => {
    server.use(http.get('*/api/quotes', () => HttpResponse.json({ quotes: [], closes: [] })));
    renderPage(<Holdings />);
    const vti = (await screen.findByText('VTI')).closest('tr') as HTMLElement;
    expect(within(vti).getByText('$300.00')).toBeInTheDocument();
    const todays = screen.getByText("Today's change").closest('div') as HTMLElement;
    expect(within(todays).getByText('—')).toBeInTheDocument();
    // No live quotes: no ((o)), whatever the time of day.
    expect(screen.queryByLabelText('Live')).not.toBeInTheDocument();
  });

  it('lists accounts valued by their balance, so the total adds up to the assets, and edits their category', async () => {
    server.use(http.get('*/api/quotes', () => HttpResponse.json({ quotes: [], closes: [] })));
    const { user } = renderPage(<Holdings />);
    const home = (await screen.findByText('Home')).closest('tr') as HTMLElement;
    expect(within(home).getByText('Property')).toBeInTheDocument();
    expect(within(home).getByText('Account balance')).toBeInTheDocument();
    expect(within(home).getByText('$900,000.00')).toBeInTheDocument();
    const total = screen.getByText('Total value').closest('div') as HTMLElement;
    expect(within(total).getByText('$1,268,500.00')).toBeInTheDocument(); // holdings $268,500 + balances $1,000,000

    await user.click(within(home).getByRole('button', { name: 'Real estate' }));
    expect(await screen.findByRole('dialog', { name: 'Home' })).toBeInTheDocument();
  });

  it("lists bank accounts' cash in their currency's cash row, which isn't reclassified", async () => {
    const { user } = renderPage(<Holdings />);
    const usd = (await screen.findByText('US Dollar (cash)')).closest('tr') as HTMLElement;
    expect(within(usd).getByText('$8,500.00')).toBeInTheDocument();
    expect(within(usd).queryByRole('button', { name: 'Cash' })).not.toBeInTheDocument();
    await user.click(within(usd).getByRole('button', { name: 'Show accounts' }));
    expect(screen.getByText('Northwind Checking')).toBeInTheDocument();
    // Another currency's cash, its own row: priced in the selected currency (A$1 = US$0.67 here).
    const aud = screen.getByText('AUD').closest('tr') as HTMLElement;
    expect(within(aud).getByText('$0.67')).not.toHaveAttribute('title');
    expect(within(aud).getByText('$10,000.00')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    server.use(http.get('*/api/portfolio', () => HttpResponse.json({ ...portfolio(), holdings: [], balances: [] })));
    renderPage(<Holdings />);
    expect(await screen.findByText('No holdings yet')).toBeInTheDocument();
  });
});
