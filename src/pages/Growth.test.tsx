import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderPage } from '../test/render';
import { http, HttpResponse } from 'msw';
import { history } from '../test/fixtures';
import { sent, server } from '../test/server';
import { Growth } from './Growth';

const lastGroup = () => sent('GET /api/history').at(-1)?.url.searchParams.get('group');

describe('Growth page', () => {
  it('breaks growth down by account with start, end and change', async () => {
    renderPage(<Growth />);
    const row = (await screen.findByRole('row', { name: /Vanguard Brokerage/ })) as HTMLElement;
    expect(within(row).getByText('$240,000.00')).toBeInTheDocument();
    expect(within(row).getByText('$250,000.00')).toBeInTheDocument();
    expect(within(row).getByText('$10,000.00', { exact: false, selector: 'td *, td' })).toBeInTheDocument();
    expect(lastGroup()).toBe('account');
  });

  it('switches to the category view; no total view (that is the Net worth chart)', async () => {
    const { user } = renderPage(<Growth />);
    await screen.findByRole('row', { name: /Vanguard Brokerage/ });
    expect(screen.queryByRole('tab', { name: 'Total' })).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'By category' }));
    expect(await screen.findByRole('row', { name: /Liabilities/ })).toBeInTheDocument();
    expect(lastGroup()).toBe('category');
    await user.click(screen.getByRole('tab', { name: '2Y' }));
    expect(sent('GET /api/history').at(-1)?.url.searchParams.get('range')).toBe('2Y');
  });

  it('picks an account from its type group; by account it shows the holdings, by category its split; All accounts shows all again', async () => {
    const { user } = renderPage(<Growth />);
    await screen.findByRole('option', { name: 'Vanguard Brokerage' });
    const picker = screen.getByRole('combobox', { name: 'Account' });
    expect(within(picker).getByRole('option', { name: 'All accounts' })).toBeInTheDocument();
    const investments = within(picker).getByRole('group', { name: 'Investments' });
    expect(within(investments).getByRole('option', { name: 'Vanguard Brokerage' })).toBeInTheDocument();

    // Clicking a row picks it, staying on the view.
    await user.click(await screen.findByRole('row', { name: /Vanguard Brokerage/ }));
    expect(picker).toHaveValue('brk');
    // Its holdings, so the view says so.
    expect(screen.getByRole('tab', { name: 'By holding', selected: true })).toBeInTheDocument();
    expect(sent('GET /api/history').at(-1)?.url.searchParams.get('accountId')).toBe('brk');
    expect(lastGroup()).toBe('holding');
    const sold = await screen.findByRole('row', { name: /SOLD/ });
    expect(within(sold).getByText('-$5,000.00')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'By category' }));
    expect(lastGroup()).toBe('category');
    expect(sent('GET /api/history').at(-1)?.url.searchParams.get('accountId')).toBe('brk');

    await user.selectOptions(picker, '');
    await expect.poll(() => sent('GET /api/history').at(-1)?.url.searchParams.has('accountId')).toBe(false);
  });

  it('shows the balance of an account without holdings', async () => {
    const { user } = renderPage(<Growth />);
    // Labelled with its institution and last digits.
    await screen.findByRole('option', { name: 'Northwind Checking ··1234' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Account' }), 'chk');
    await expect.poll(() => sent('GET /api/history').at(-1)?.url.searchParams.get('accountId')).toBe('chk');
    expect(lastGroup()).toBe('account');
    expect(await screen.findByRole('row', { name: /Northwind Checking/ })).toBeInTheDocument();
  });

  it('shows where the value came from: money in and out, returns, and both against the balance, with a table of each part', async () => {
    const { user } = renderPage(<Growth />);
    await screen.findByRole('row', { name: /Vanguard Brokerage/ });

    await user.click(screen.getByRole('tab', { name: 'Activity' }));
    await expect.poll(lastGroup).toBe('source');
    const household = await screen.findByRole('row', { name: /Household/ });
    // Start, money in, money out, dividends and interest, fees, market gain/loss, now.
    expect(within(household).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['Household', '$240,000.00', '$5,000.00', '-$1,000.00', '$300.00', '-$50.00', '$5,750.00', '$250,000.00']);
    expect(screen.getByText(/Transfers between your accounts are left out/)).toBeInTheDocument();
    expect(screen.getByText(/2 transactions need a type/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set types' })).toHaveAttribute('href', '/transactions');
    // No changes it couldn't tell apart: no column for them.
    expect(screen.queryByRole('columnheader', { name: 'Not broken down' })).toBeNull();
    expect(screen.getByText('Money in', { selector: 'li *' })).toBeInTheDocument();
    expect(screen.getByText('Money out', { selector: 'li *' })).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Returns' }));
    expect(screen.getByText('Market gain/loss', { selector: 'li *' })).toBeInTheDocument();
    expect(screen.getByText('Dividends and interest', { selector: 'li *' })).toBeInTheDocument();
    expect(screen.getByText('Fees', { selector: 'li *' })).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(screen.getByText('Balance', { selector: 'li *' })).toBeInTheDocument();
    expect(screen.getByText('Net deposits', { selector: 'li *' })).toBeInTheDocument();
    expect(screen.getByText('Investment returns', { selector: 'li *' })).toBeInTheDocument();
    // The split control is Balance's only.
    expect(screen.queryByRole('tab', { name: 'By category' })).toBeNull();

    // Back to the balance by account.
    await user.click(screen.getByRole('tab', { name: 'Balance' }));
    await expect.poll(lastGroup).toBe('account');
  });

  it('says so when there is nothing to chart, rather than an empty chart', async () => {
    const { user } = renderPage(<Growth />);
    await screen.findByRole('row', { name: /Vanguard Brokerage/ });
    const quiet = history('source');
    quiet.series = quiet.series.map((series) => (series.key === 'balance' ? series : { ...series, values: series.values.map(() => 0) }));
    server.use(http.get('*/api/history', () => HttpResponse.json(quiet)));
    await user.click(screen.getByRole('tab', { name: 'Activity' }));
    expect(await screen.findByText(/No money in or out in this range/)).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Returns' }));
    expect(await screen.findByText(/No dividends, fees or market gain or loss/)).toBeInTheDocument();
  });
});
