import { fireEvent, screen, within } from '@testing-library/react';
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
    const dialog = await screen.findByRole('dialog', { name: 'Example Super' });
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
    await user.click(within(rowFor('Northwind Checking')).getByRole('button', { name: 'Edit account' }));
    const dialog = await screen.findByRole('dialog', { name: 'Northwind Checking' });
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
    dialog = await screen.findByRole('dialog', { name: 'Northwind Checking' });
    expect(within(dialog).getByText(/no longer reports this account/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /Delete/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Delete account and history' }));
    await expect.poll(() => sent('DELETE /api/accounts/chk').length).toBe(1);
  });
});

describe('CSV import', () => {
  const examplebank = `Bank Account,Date,Description,Debit Amount,Credit Amount,Balance,Category,Reference
000000123456,03/10/2026,COFFEE,4.50,,1995.50,OTHER,
000000123456,03/10/2026,SALARY,,1000.00,2000.00,INCOME,
000000123456,01/10/2026,RENT,600.00,,1000.00,OTHER,
`;

  it('recognises a Example Bank export, previews and imports daily balances', async () => {
    server.use(http.post('*/api/imports/balances', () => HttpResponse.json({ imported: 3 })));
    const { user } = await openAccounts();
    await user.click(screen.getByRole('button', { name: /Import CSV/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Import balance history' });
    await user.selectOptions(within(dialog).getByLabelText('Account'), 'wbc');
    const file = new File([examplebank], 'examplebank.csv', { type: 'text/csv' });
    fireEvent.change(within(dialog).getByLabelText('CSV file'), { target: { files: [file] } });

    expect(await within(dialog).findByText(/Recognised a bank transactions export/)).toBeInTheDocument();
    expect(within(dialog).getByText(/2 balances, filling 3 days/)).toBeInTheDocument(); // the 2nd carries the 1st
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));

    await expect.poll(() => sent('POST /api/imports/balances')[0]?.body).toEqual({
      accountId: 'wbc',
      rows: [
        { date: '2026-10-01', balance: 1000 },
        { date: '2026-10-03', balance: 1995.5 },
      ],
    });
    expect(await within(dialog).findByText('Imported 3 days.')).toBeInTheDocument();

    // Closing clears it for the next import.
    await user.click(within(dialog).getByText('Close', { selector: 'button' })); // the footer button, not the ×
    await user.click(screen.getByRole('button', { name: /Import CSV/ }));
    const reopened = await screen.findByRole('dialog', { name: 'Import balance history' });
    expect(within(reopened).getByLabelText('Account')).toHaveValue('');
    expect(within(reopened).queryByText(/Recognised/)).not.toBeInTheDocument();
    expect(within(reopened).queryByText(/Imported/)).not.toBeInTheDocument();
  });

  // Made up: two cash accounts in one download, a column each.
  const vanguard = `Account Number,Investment Name,Symbol,Shares,Share Price,Total Value,
66665678,EXAMPLE MONEY MARKET FUND,XYZMM,500.00,1,500.00,
55551234,EXAMPLE MONEY MARKET FUND,XYZMM,2000.00,1,2000.00,

Account Number,Trade Date,Settlement Date,Transaction Type,Transaction Description,Investment Name,Symbol,Shares,Share Price,Principal Amount,Commissions and Fees,Net Amount,Accrued Interest,Account Type,
66665678,2026-09-01,2026-09-01,Deposit,Electronic Funds Transfer,CASH,,0.00000,1.0,500.00,0.0,500.00,0.0,CASH,
55551234,2026-09-02,2026-09-02,Deposit,Electronic Funds Transfer,CASH,,0.00000,1.0,2000.00,0.0,2000.00,0.0,CASH,
`;

  it("picks the balance column of the chosen account by its last digits, whichever is chosen first", async () => {
    const { user } = await openAccounts();
    await user.click(screen.getByRole('button', { name: /Import CSV/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Import balance history' });
    const load = () => fireEvent.change(within(dialog).getByLabelText('CSV file'), { target: { files: [new File([vanguard], 'download.csv', { type: 'text/csv' })] } });

    load();
    expect(await within(dialog).findByText(/Recognised a Vanguard download/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Balance column')).toHaveDisplayValue('Account ending 5678'); // the first
    await user.selectOptions(within(dialog).getByLabelText('Account'), 'chk'); // mask 1234
    expect(within(dialog).getByLabelText('Balance column')).toHaveDisplayValue('Account ending 1234');

    // Account first, then the file.
    await user.click(within(dialog).getByText('Close', { selector: 'button' }));
    await user.click(screen.getByRole('button', { name: /Import CSV/ }));
    const again = await screen.findByRole('dialog', { name: 'Import balance history' });
    await user.selectOptions(within(again).getByLabelText('Account'), 'chk');
    fireEvent.change(within(again).getByLabelText('CSV file'), { target: { files: [new File([vanguard], 'download.csv', { type: 'text/csv' })] } });
    await within(again).findByText(/Recognised a Vanguard download/);
    expect(within(again).getByLabelText('Balance column')).toHaveDisplayValue('Account ending 1234');
  });

  it("imports an investment account's holdings history from a download when it has priced holdings", async () => {
    // The brokerage (made-up mask 4321) holds a priced fund: no balance column, its holdings instead.
    server.use(http.get('*/api/accounts', () => HttpResponse.json({ accounts: ACCOUNTS.map((account) => (account.id === 'brk' ? { ...account, mask: '4321' } : account)) })));
    server.use(http.post('*/api/imports/holdings-history', () => HttpResponse.json({ days: 120, from: '2026-06-01', to: '2026-09-28' })));
    const file = `Account Number,Investment Name,Symbol,Shares,Share Price,Total Value,
55554321,EXAMPLE STOCK FUND,XYZ,10.00,100,1000.00,
55554321,EXAMPLE MONEY MARKET FUND,XYZMM,50.00,1,50.00,

Account Number,Trade Date,Settlement Date,Transaction Type,Transaction Description,Investment Name,Symbol,Shares,Share Price,Principal Amount,Commissions and Fees,Net Amount,Accrued Interest,Account Type,
55554321,2026-06-01,2026-06-02,Buy,Buy,EXAMPLE STOCK FUND,XYZ,10.00000,100.0,-1000.00,0.0,-1000.00,0.0,CASH,
55554321,2026-06-01,2026-06-01,Funds Received,Funds received,,,0.00000,0.0,1050.00,0.0,1050.00,0.0,CASH,
`;
    const { user } = await openAccounts();
    await user.click(screen.getByRole('button', { name: /Import CSV/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Import balance history' });
    await user.selectOptions(within(dialog).getByLabelText('Account'), 'brk');
    fireEvent.change(within(dialog).getByLabelText('CSV file'), { target: { files: [new File([file], 'download.csv', { type: 'text/csv' })] } });
    expect(await within(dialog).findByText('Holdings history')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Balance column')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));
    await expect.poll(() => sent('POST /api/imports/holdings-history')[0]?.body).toEqual({
      accountId: 'brk',
      positions: [
        { ticker: 'XYZ', shares: 10 },
        { ticker: 'XYZMM', shares: 50 },
      ],
      transactions: [
        { date: '2026-06-01', settled: '2026-06-02', type: 'Buy', ticker: 'XYZ', shares: 10, price: 100, amount: -1000_00 },
        { date: '2026-06-01', settled: '2026-06-01', type: 'Funds Received', ticker: null, shares: 0, price: 0, amount: 1050_00 },
      ],
    });
    expect(await within(dialog).findByText(/Importing 120 days of holdings/)).toBeInTheDocument();
  });

  it('lets you map columns for other files', async () => {
    const { user } = await openAccounts();
    await user.click(screen.getByRole('button', { name: /Import CSV/ }));
    const dialog = await screen.findByRole('dialog');
    const file = new File(['when,note,amount\n01/02/2026,x,100\n01/03/2026,y,105\n'], 'bank.csv', { type: 'text/csv' });
    fireEvent.change(within(dialog).getByLabelText('CSV file'), { target: { files: [file] } });
    await within(dialog).findByLabelText('Date column');
    await user.selectOptions(within(dialog).getByLabelText('Date format'), 'MM/DD/YYYY');
    expect(within(dialog).getByText(/2 balances, filling 2 days/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Import' })).toBeDisabled(); // no account chosen
    await user.selectOptions(within(dialog).getByLabelText('Balance column'), '1');
    expect(within(dialog).getByText(/0 balances/)).toBeInTheDocument();
  });
});
