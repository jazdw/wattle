import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { Accounts } from '../pages/Accounts';
import { ACCOUNTS } from '../test/fixtures';
import { renderPage } from '../test/render';
import { sent, server } from '../test/server';

async function openAccounts() {
  const result = renderPage(<Accounts />);
  await screen.findByText('Travel Card');
  return result;
}

const rowFor = (name: string) => screen.getByText(name).closest('li') as HTMLElement;

describe('manual accounts', () => {
  it('creates an account with an opening balance', async () => {
    const { user } = await openAccounts();
    await user.click(screen.getByRole('button', { name: /Manual account/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a manual account' });
    // In the currency shown (the household's, USD) until another is picked.
    expect(within(dialog).getByLabelText('Currency')).toHaveValue('USD');
    await user.selectOptions(within(dialog).getByLabelText('Currency'), 'AUD');
    await user.type(within(dialog).getByLabelText('Name'), 'Example Super (Sam)');
    await user.type(within(dialog).getByLabelText('Institution'), 'Example Super Fund');
    await user.selectOptions(within(dialog).getByLabelText('Type'), 'investment');
    await user.selectOptions(within(dialog).getByLabelText('Owner'), 'u-partner');
    await user.selectOptions(within(dialog).getByLabelText(/Allocation category/), 'au_stock');
    await user.type(within(dialog).getByLabelText('Current balance'), '185000');
    await user.click(within(dialog).getByRole('button', { name: 'Add account' }));

    await expect.poll(() => sent('POST /api/accounts').length).toBe(1);
    expect(sent('POST /api/accounts')[0].body).toMatchObject({
      name: 'Example Super (Sam)',
      institutionName: 'Example Super Fund',
      type: 'investment',
      currency: 'AUD',
      category: 'au_stock',
      ownerUserId: 'u-partner',
      balance: 185000,
    });
  });

  it('labels the balance as an amount owed for liabilities', async () => {
    const { user } = await openAccounts();
    await user.click(screen.getByRole('button', { name: /Manual account/ }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('Type'), 'loan');
    expect(within(dialog).getByLabelText('Amount owed')).toBeInTheDocument();
  });

  it('records a dated balance and shows past entries', async () => {
    server.use(
      http.get('*/api/accounts/super/balances', () =>
        HttpResponse.json({ balances: [{ date: '2026-09-30', balance: 148000_00, source: 'manual' }] }),
      ),
    );
    const { user } = await openAccounts();
    await user.click(within(rowFor('Example Super')).getByRole('button', { name: 'Edit account' }));
    const dialog = await screen.findByRole('dialog', { name: 'Example Super Fund · Example Super' });
    expect(await within(dialog).findByText(/Sep 30, 2026/)).toBeInTheDocument();
    expect(within(dialog).getByText('in AUD')).toBeInTheDocument(); // the account's own currency
    await user.type(within(dialog).getByLabelText('Balance (AUD)'), '152000');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await expect.poll(() => sent('POST /api/accounts/super/balances').length).toBe(1);
    expect(sent('POST /api/accounts/super/balances')[0].body).toMatchObject({ balance: 152000 });
  });

  it('deletes a manual account only after confirming', async () => {
    const { user } = await openAccounts();
    await user.click(within(rowFor('Example Super')).getByRole('button', { name: 'Edit account' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /Delete/ }));
    expect(sent('DELETE /api/accounts/super')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Delete account and history' }));
    await expect.poll(() => sent('DELETE /api/accounts/super').length).toBe(1);
  });

  it('edits holdings by ticker, with unit prices for unlisted funds', async () => {
    server.use(
      http.get('*/api/accounts/super/holdings', () =>
        HttpResponse.json({ holdings: [{ ticker: 'VAS', name: 'Vanguard Australian Shares', quantity: 100, price: 100, value: 10000_00, isPublic: true }], version: 4 }),
      ),
      http.put('*/api/accounts/super/holdings', () => HttpResponse.json({ ok: true, unpriced: 0 })),
    );
    const { user } = await openAccounts();
    await user.click(within(rowFor('Example Super')).getByRole('button', { name: 'Edit holdings' }));
    const dialog = await screen.findByRole('dialog', { name: /Holdings — Example Super/ });
    expect(await within(dialog).findByDisplayValue('VAS')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /Add holding/ }));
    const inputs = within(dialog).getAllByRole('textbox');
    // Second row: ticker, name, units, unit price
    await user.type(inputs[4], 'xmpl-bal');
    await user.type(inputs[6], '1000');
    await user.type(inputs[7], '1.85');
    await user.click(within(dialog).getByRole('button', { name: 'Save holdings' }));

    await expect.poll(() => sent('PUT /api/accounts/super/holdings').length).toBe(1);
    expect(sent('PUT /api/accounts/super/holdings')[0].body).toEqual({
      holdings: [
        { ticker: 'VAS', name: 'Vanguard Australian Shares', quantity: 100 },
        { ticker: 'XMPL-BAL', quantity: 1000, price: 1.85 },
      ],
      version: 4, // what the editor loaded
    });
  });

  it('hides a linked account, optionally deleting its history', async () => {
    const { user } = await openAccounts();
    await user.click(within(rowFor('Northwind Checking')).getByRole('button', { name: 'Edit account' }));
    const dialog = await screen.findByRole('dialog', { name: 'Northwind Checking ··1234' });
    expect(within(dialog).queryByText(/Record a balance/)).not.toBeInTheDocument(); // linked: no manual balances
    await user.click(within(dialog).getByRole('switch', { name: /Hide this account/ }));
    await user.click(within(dialog).getByRole('switch', { name: /delete its stored history/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await expect.poll(() => sent('PATCH /api/accounts/chk')[0]?.body).toMatchObject({ isHidden: true, purge: true });
  });

  it('deletes a linked account only once the institution no longer reports it', async () => {
    server.use(http.get('*/api/accounts', () => HttpResponse.json({ accounts: ACCOUNTS.map((account) => (account.id === 'chk' ? { ...account, missingSince: Date.now(), balance: null } : account)) })));
    const { user } = await openAccounts();
    // Still reported: hide only.
    await user.click(within(rowFor('Vanguard Brokerage')).getByRole('button', { name: 'Edit account' }));
    let dialog = await screen.findByRole('dialog', { name: 'Vanguard Brokerage' });
    expect(within(dialog).queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await user.click(within(rowFor('Northwind Checking')).getByRole('button', { name: 'Edit account' }));
    dialog = await screen.findByRole('dialog', { name: 'Northwind Checking ··1234' });
    expect(within(dialog).getByText(/no longer reports this account/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /Delete/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Delete account and history' }));
    await expect.poll(() => sent('DELETE /api/accounts/chk').length).toBe(1);
  });
});

describe('importing', () => {
  it("shows an import's progress on its account while it's written", async () => {
    server.use(http.get('*/api/accounts', () => HttpResponse.json({ accounts: ACCOUNTS.map((account) => (account.id === 'brk' ? { ...account, importProgress: { done: 3, total: 12 } } : account)) })));
    await openAccounts();
    expect(within(rowFor('Vanguard Brokerage')).getByText('Importing history… 3 of 12')).toBeInTheDocument();
  });
});
