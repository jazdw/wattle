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
    expect(within(row).getByText('+$10,000')).toBeInTheDocument();
    expect(screen.getByText(/Shaded periods/)).toBeInTheDocument();
    expect(lastGroup()).toBe('account');
  });

  it('switches between total and category views', async () => {
    const { user } = renderPage(<Growth />);
    await screen.findByRole('row', { name: /Vanguard Brokerage/ });
    await user.click(screen.getByRole('tab', { name: 'By category' }));
    expect(await screen.findByRole('row', { name: /Liabilities/ })).toBeInTheDocument();
    expect(lastGroup()).toBe('category');

    await user.click(screen.getByRole('tab', { name: 'Total' }));
    expect(await screen.findByRole('row', { name: /Net worth/ })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: '2Y' }));
    expect(sent('GET /api/history').at(-1)?.url.searchParams.get('range')).toBe('2Y');
  });

  it('drills into an account’s holdings, including sold ones, and back out', async () => {
    const { user } = renderPage(<Growth />);
    // Clicking a row drills in (only accounts with holdings can).
    await user.click(await screen.findByRole('row', { name: /Vanguard Brokerage/ }));
    expect(await screen.findByText('Vanguard Brokerage — holdings')).toBeInTheDocument();
    expect(sent('GET /api/history').at(-1)?.url.searchParams.get('accountId')).toBe('brk');
    const sold = await screen.findByRole('row', { name: /SOLD/ });
    expect(within(sold).getByText('-$5,000')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /All accounts/ }));
    expect(await screen.findByRole('tab', { name: 'By account' })).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: /Drill into/ }), 'brk');
    expect(await screen.findByText('Vanguard Brokerage — holdings')).toBeInTheDocument();
  });
});
