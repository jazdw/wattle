import { fireEvent, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { Accounts } from '../pages/Accounts';
import { ACCOUNTS } from '../test/fixtures';
import { renderPage } from '../test/render';
import { sent, server } from '../test/server';

async function openAccounts() {
  const result = renderPage(<Accounts />);
  await screen.findByText('Sapphire');
  return result;
}

const rowFor = (name: string) => screen.getByText(name).closest('li') as HTMLElement;

describe('manual accounts', () => {
  it('creates an account with an opening balance', async () => {
    const { user } = await openAccounts();
    await user.click(screen.getByRole('button', { name: /Manual account/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a manual account' });
    await user.type(within(dialog).getByLabelText('Name'), 'REST Super (Sam)');
    await user.type(within(dialog).getByLabelText('Institution'), 'REST');
    await user.selectOptions(within(dialog).getByLabelText('Type'), 'investment');
    await user.selectOptions(within(dialog).getByLabelText('Owner'), 'u-partner');
    await user.selectOptions(within(dialog).getByLabelText(/Allocation category/), 'au_stock');
    await user.type(within(dialog).getByLabelText('Current balance'), '185000');
    await user.click(within(dialog).getByRole('button', { name: 'Add account' }));

    await expect.poll(() => sent('POST /api/accounts').length).toBe(1);
    expect(sent('POST /api/accounts')[0].body).toMatchObject({
      name: 'REST Super (Sam)',
      institutionName: 'REST',
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
    await user.click(within(rowFor('REST Super')).getByRole('button', { name: 'Edit account' }));
    const dialog = await screen.findByRole('dialog', { name: 'REST Super' });
    expect(await within(dialog).findByText(/Sep 30, 2026/)).toBeInTheDocument();
    expect(within(dialog).getByText('in AUD')).toBeInTheDocument(); // the account's own currency
    await user.type(within(dialog).getByLabelText('Balance (AUD)'), '152000');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await expect.poll(() => sent('POST /api/accounts/super/balances').length).toBe(1);
    expect(sent('POST /api/accounts/super/balances')[0].body).toMatchObject({ balance: 152000 });
  });

  it('deletes a manual account only after confirming', async () => {
    const { user } = await openAccounts();
    await user.click(within(rowFor('REST Super')).getByRole('button', { name: 'Edit account' }));
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
    await user.click(within(rowFor('REST Super')).getByRole('button', { name: 'Edit holdings' }));
    const dialog = await screen.findByRole('dialog', { name: /Holdings — REST Super/ });
    expect(await within(dialog).findByDisplayValue('VAS')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /Add holding/ }));
    const inputs = within(dialog).getAllByRole('textbox');
    // Second row: ticker, name, units, unit price
    await user.type(inputs[4], 'rest-bal');
    await user.type(inputs[6], '1000');
    await user.type(inputs[7], '1.85');
    await user.click(within(dialog).getByRole('button', { name: 'Save holdings' }));

    await expect.poll(() => sent('PUT /api/accounts/super/holdings').length).toBe(1);
    expect(sent('PUT /api/accounts/super/holdings')[0].body).toEqual({
      holdings: [
        { ticker: 'VAS', name: 'Vanguard Australian Shares', quantity: 100 },
        { ticker: 'REST-BAL', quantity: 1000, price: 1.85 },
      ],
      version: 4, // what the editor loaded
    });
  });

  it('hides a linked account, optionally deleting its history', async () => {
    const { user } = await openAccounts();
    await user.click(within(rowFor('Chase Checking')).getByRole('button', { name: 'Edit account' }));
    const dialog = await screen.findByRole('dialog', { name: 'Chase Checking' });
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

    await user.click(within(rowFor('Chase Checking')).getByRole('button', { name: 'Edit account' }));
    dialog = await screen.findByRole('dialog', { name: 'Chase Checking' });
    expect(within(dialog).getByText(/no longer reports this account/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /Delete/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Delete account and history' }));
    await expect.poll(() => sent('DELETE /api/accounts/chk').length).toBe(1);
  });

  it('asks whether an account chosen again is the deselected one, and sends the answer', async () => {
    server.use(
      http.get('*/api/accounts', () =>
        HttpResponse.json({
          accounts: [
            ...ACCOUNTS.map((account) => (account.id === 'chk' ? { ...account, missingSince: Date.now() - 86400_000, balance: null } : account)),
            { ...ACCOUNTS.find((account) => account.id === 'chk')!, id: 'chk-again', possibleReturnOf: 'chk' },
          ],
        }),
      ),
    );
    const { user } = await openAccounts();
    const rows = screen.getAllByText('Chase Checking').map((element) => element.closest('li') as HTMLElement);
    const fresh = rows.find((row) => within(row).queryByText('Same as a deselected account?'))!;
    await user.click(within(fresh).getByRole('button', { name: 'Edit account' }));
    const dialog = await screen.findByRole('dialog', { name: 'Chase Checking' });
    expect(within(dialog).getByText(/which you deselected earlier/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Same account, keep its history' }));
    await expect.poll(() => sent('POST /api/accounts/chk-again/returning')[0]?.body).toEqual({ of: 'chk', same: true });
  });
});

describe('CSV import', () => {
  const westpac = `Bank Account,Date,Narrative,Debit Amount,Credit Amount,Balance,Categories,Serial
032000123456,03/10/2026,COFFEE,4.50,,1995.50,OTHER,
032000123456,03/10/2026,SALARY,,1000.00,2000.00,INCOME,
032000123456,01/10/2026,RENT,600.00,,1000.00,OTHER,
`;

  it('recognises a Westpac export, previews and imports daily balances', async () => {
    server.use(http.post('*/api/imports/balances', () => HttpResponse.json({ imported: 2 })));
    const { user } = await openAccounts();
    await user.click(screen.getByRole('button', { name: /Import CSV/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Import balance history' });
    await user.selectOptions(within(dialog).getByLabelText('Account'), 'wbc');
    const file = new File([westpac], 'westpac.csv', { type: 'text/csv' });
    fireEvent.change(within(dialog).getByLabelText('CSV file'), { target: { files: [file] } });

    expect(await within(dialog).findByText(/Recognised a Westpac transactions export/)).toBeInTheDocument();
    expect(within(dialog).getByText(/2 days/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));

    await expect.poll(() => sent('POST /api/imports/balances')[0]?.body).toEqual({
      accountId: 'wbc',
      overwrite: false,
      rows: [
        { date: '2026-10-01', balance: 1000 },
        { date: '2026-10-03', balance: 1995.5 },
      ],
    });
    expect(await within(dialog).findByText('Imported 2 days.')).toBeInTheDocument();

    // Closing clears it for the next import.
    await user.click(within(dialog).getByText('Close', { selector: 'button' })); // the footer button, not the ×
    await user.click(screen.getByRole('button', { name: /Import CSV/ }));
    const reopened = await screen.findByRole('dialog', { name: 'Import balance history' });
    expect(within(reopened).getByLabelText('Account')).toHaveValue('');
    expect(within(reopened).queryByText(/Recognised/)).not.toBeInTheDocument();
    expect(within(reopened).queryByText(/Imported/)).not.toBeInTheDocument();
  });

  it('lets you map columns for other files', async () => {
    const { user } = await openAccounts();
    await user.click(screen.getByRole('button', { name: /Import CSV/ }));
    const dialog = await screen.findByRole('dialog');
    const file = new File(['when,note,amount\n01/02/2026,x,100\n01/03/2026,y,105\n'], 'bank.csv', { type: 'text/csv' });
    fireEvent.change(within(dialog).getByLabelText('CSV file'), { target: { files: [file] } });
    await within(dialog).findByLabelText('Date column');
    await user.selectOptions(within(dialog).getByLabelText('Date format'), 'MM/DD/YYYY');
    expect(within(dialog).getByText(/2 days/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Import' })).toBeDisabled(); // no account chosen
    await user.selectOptions(within(dialog).getByLabelText('Balance column'), '1');
    expect(within(dialog).getByText(/0 days/)).toBeInTheDocument();
  });
});
