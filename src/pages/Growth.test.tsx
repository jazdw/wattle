import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderPage } from '../test/render';
import { sent } from '../test/server';
import { Growth } from './Growth';

const lastGroup = () => sent('GET /api/history').at(-1)?.url.searchParams.get('group');

describe('Growth page', () => {
  it('breaks growth down by account with start, end and change', async () => {
    renderPage(<Growth />);
    const row = (await screen.findByRole('row', { name: /Vanguard Brokerage/ })) as HTMLElement;
    expect(within(row).getByText('$240,000')).toBeInTheDocument();
    expect(within(row).getByText('$250,000')).toBeInTheDocument();
    expect(within(row).getByText('$10,000', { exact: false, selector: 'td *, td' })).toBeInTheDocument();
    expect(screen.getByText(/Shaded periods/)).toBeInTheDocument();
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

  it('picks an account from its type group; by account it shows the holdings, by category its split; clearing shows all again', async () => {
    const { user } = renderPage(<Growth />);
    await screen.findByRole('option', { name: 'Vanguard Brokerage' });
    const picker = screen.getByRole('combobox', { name: 'Account' });
    expect(within(picker).getByRole('option', { name: 'All accounts' })).toBeInTheDocument();
    const investments = within(picker).getByRole('group', { name: 'Investments' });
    expect(within(investments).getByRole('option', { name: 'Vanguard Brokerage' })).toBeInTheDocument();

    // Clicking a row picks it, staying on the view.
    await user.click(await screen.findByRole('row', { name: /Vanguard Brokerage/ }));
    expect(picker).toHaveValue('brk');
    expect(screen.getByRole('tab', { name: 'By account', selected: true })).toBeInTheDocument();
    expect(sent('GET /api/history').at(-1)?.url.searchParams.get('accountId')).toBe('brk');
    expect(lastGroup()).toBe('holding');
    const sold = await screen.findByRole('row', { name: /SOLD/ });
    expect(within(sold).getByText('-$5,000')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'By category' }));
    expect(lastGroup()).toBe('category');
    expect(sent('GET /api/history').at(-1)?.url.searchParams.get('accountId')).toBe('brk');

    await user.click(screen.getByRole('button', { name: 'Show all accounts' }));
    expect(picker).toHaveValue('');
    expect(sent('GET /api/history').at(-1)?.url.searchParams.get('accountId')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show all accounts' })).toBeNull();
  });

  it('shows the balance of an account without holdings', async () => {
    const { user } = renderPage(<Growth />);
    await screen.findByRole('option', { name: 'Chase Checking' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Account' }), 'chk');
    await expect.poll(() => sent('GET /api/history').at(-1)?.url.searchParams.get('accountId')).toBe('chk');
    expect(lastGroup()).toBe('account');
    expect(await screen.findByRole('row', { name: /Chase Checking/ })).toBeInTheDocument();
  });
});
