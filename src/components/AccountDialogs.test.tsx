import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { Accounts } from '../pages/Accounts';
import { ACCOUNTS } from '../test/fixtures';
import { bankSgml, buy, sgml, sgmlAccounts } from '../test/ofx';
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

describe('Import', () => {
  // Made up: a bank's transaction export, newest first, with a running balance.
  const bank = `Account,Date,Description,Debit,Credit,Balance,Category
000000123456,03/10/2026,COFFEE,4.50,,1995.50,OTHER
000000123456,03/10/2026,SALARY,,1000.00,2000.00,INCOME
000000123456,01/10/2026,RENT,600.00,,1000.00,OTHER
000000123456,28/09/2026,GROCERIES,50.00,,1600.00,OTHER
`;
  const upload = (dialog: HTMLElement, ...contents: string[]) =>
    fireEvent.change(within(dialog).getByLabelText('Files'), { target: { files: contents.map((content, index) => new File([content], `file${index}`, { type: 'text/plain' })) } });
  async function openImport() {
    const opened = await openAccounts();
    await opened.user.click(screen.getByRole('button', { name: 'Import' }));
    return { ...opened, dialog: await screen.findByRole('dialog', { name: 'Import history' }) };
  }
  const accepted = { accounts: [] };

  it('finds the date and balance columns of a CSV, previews and imports daily balances, then closes', async () => {
    server.use(http.post('*/api/imports', () => HttpResponse.json(accepted)));
    const { user, dialog } = await openImport();
    upload(dialog, bank);

    expect(await within(dialog).findByText(/Found its date and balance columns/)).toBeInTheDocument();
    // The 28th says the day comes first. The import carries each balance to the next, so 3 balances fill 6 days.
    expect(within(dialog).getByText(/3 balances, filling 6 days/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Import' })).toBeDisabled(); // no account chosen
    await user.selectOptions(within(dialog).getByLabelText('Import The file into'), 'wbc');
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));

    await expect.poll(() => sent('POST /api/imports')[0]?.body).toEqual({
      accounts: [
        {
          label: 'The file',
          target: { accountId: 'wbc' },
          file: {
            kind: 'balances',
            rows: [
              { date: '2026-09-28', balance: 1600 },
              { date: '2026-10-01', balance: 1000 },
              { date: '2026-10-03', balance: 1995.5 },
            ],
          },
        },
      ],
    });
    // Accepted: the dialog closes; reopened, it starts afresh.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Import history' })).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Import' }));
    const reopened = await screen.findByRole('dialog', { name: 'Import history' });
    expect(within(reopened).queryByText(/Found its/)).not.toBeInTheDocument();
  });

  it('imports every account in a download: matched by last digits, new, or skipped', async () => {
    server.use(http.get('*/api/accounts', () => HttpResponse.json({ accounts: ACCOUNTS.map((account) => (account.id === 'brk' ? { ...account, mask: '4321' } : account)) })));
    server.use(http.post('*/api/imports/tickers', () => HttpResponse.json({ suggestions: [] })));
    server.use(http.post('*/api/imports', () => HttpResponse.json(accepted)));
    const { user, dialog } = await openImport();
    // A brokerage you've linked (mask 4321), an account you haven't, and one sharing a linked checking account's last digits.
    upload(dialog, sgmlAccounts(['55554321', '66665678', '77771234']));

    // The brokerage is matched by its last digits; the others wait for a choice.
    expect(await within(dialog).findByLabelText('Import ··4321 into')).toHaveValue('brk');
    expect(within(dialog).getAllByText(/1 holding, 1 transaction/)).toHaveLength(3);
    expect(within(dialog).getByLabelText('Import ··5678 into')).toHaveValue('choose');
    expect(within(dialog).getByRole('button', { name: 'Import' })).toBeDisabled();

    await user.selectOptions(within(dialog).getByLabelText('Import ··5678 into'), 'new');
    expect(within(dialog).getByLabelText("New account's name")).toHaveValue('Example Plan ··5678');
    // ··1234 is the linked checking account's last digits: a new account would count it twice.
    await user.selectOptions(within(dialog).getByLabelText('Import ··1234 into'), 'new');
    expect(within(dialog).getByText(/is linked with the same last digits/)).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText('Import ··1234 into'), 'skip');
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));

    await expect.poll(() => sent('POST /api/imports')[0]?.body).toMatchObject({
      accounts: [
        { label: '··4321', target: { accountId: 'brk' }, file: { kind: 'holdings', positions: [{ security: '000000002', shares: 260, price: 13 }] } },
        { label: '··5678', target: { new: { name: 'Example Plan ··5678', type: 'investment', currency: 'USD', institutionName: 'Example Plan', mask: '5678', ownerUserId: 'u-me' } } },
      ],
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Import history' })).not.toBeInTheDocument());
  });

  it('imports a card download into a new credit card account', async () => {
    server.use(http.post('*/api/imports', () => HttpResponse.json(accepted)));
    const { user, dialog } = await openImport();
    upload(dialog, bankSgml([['20260915', '-100.00']], '-300.00', { card: true, number: '99995555' }));
    await user.selectOptions(await within(dialog).findByLabelText('Import ··5555 into'), 'new');
    expect(within(dialog).getByLabelText('Type')).toHaveValue('credit');
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));
    await expect.poll(() => sent('POST /api/imports')[0]?.body).toMatchObject({
      accounts: [{ label: '··5555', target: { new: { name: 'Example Bank ··5555', type: 'credit', currency: 'USD' } }, file: { kind: 'balances', currency: 'USD', rows: [{ date: '2026-09-01', balance: 200 }, { date: '2026-09-15', balance: 300 }, { date: '2026-10-08', balance: 300 }] } }],
    });
  });

  it("won't import an account with transaction types it doesn't understand, until it's skipped", async () => {
    server.use(http.post('*/api/imports/tickers', () => HttpResponse.json({ suggestions: [] })));
    const expense = `<INVEXPENSE><INVTRAN><FITID>E1</FITID><DTTRADE>20260901</DTTRADE></INVTRAN><SECID><UNIQUEID>000000002</UNIQUEID><UNIQUEIDTYPE>CUSIP</UNIQUEIDTYPE></SECID><TOTAL>5.00</TOTAL><SUBACCTSEC>CASH</SUBACCTSEC><SUBACCTFUND>CASH</SUBACCTFUND></INVEXPENSE>`;
    const { user, dialog } = await openImport();
    upload(dialog, sgmlAccounts(['55551111', '66665678'], { '55551111': expense }));
    await user.selectOptions(await within(dialog).findByLabelText('Import ··1111 into'), 'new');
    expect(within(dialog).getByText(/doesn't understand these transaction types yet: INVEXPENSE/)).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText('Import ··5678 into'), 'new');
    expect(within(dialog).getByRole('button', { name: 'Import' })).toBeDisabled();
    await user.selectOptions(within(dialog).getByLabelText('Import ··1111 into'), 'skip');
    expect(within(dialog).getByRole('button', { name: 'Import' })).toBeEnabled();
  });

  it('suggests a ticker for a security the file names without one, and sends what you choose', async () => {
    server.use(http.post('*/api/imports/tickers', () => HttpResponse.json({ suggestions: [{ id: '000000002', ticker: 'XYZ', from: 'search' }] })));
    server.use(http.post('*/api/imports', () => HttpResponse.json(accepted)));
    const { user, dialog } = await openImport();
    upload(dialog, sgml(buy('B1', '20260803', '10', '12.5', '125.00')));
    const ticker = await within(dialog).findByLabelText('Ticker for Example S&P Index Fund M');
    await expect.poll(() => (ticker as HTMLInputElement).value).toBe('XYZ');
    expect(within(dialog).getByText(/found by its name: check it/)).toBeInTheDocument();

    await user.clear(ticker);
    await user.type(ticker, 'not a ticker');
    await user.selectOptions(within(dialog).getByLabelText('Import ··5678 into'), 'new');
    expect(within(dialog).getByText(/That isn't a ticker/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Import' })).toBeDisabled();
    await user.clear(ticker);
    await user.type(ticker, 'abc');
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));
    await expect.poll(() => (sent('POST /api/imports')[0]?.body as { accounts: { file: { securities: unknown[] } }[] })?.accounts[0].file.securities).toEqual([
      { id: '000000002', ticker: 'ABC', name: 'Example S&P Index Fund M' },
    ]);
  });

  it('lets you map columns for other files', async () => {
    const { user, dialog } = await openImport();
    upload(dialog, 'when,note,amount\n01/02/2026,x,100\n01/03/2026,y,105\n');
    expect(await within(dialog).findByText(/Choose the columns with the date and the balance/)).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText('Date format'), 'MM/DD/YYYY');
    expect(within(dialog).getByText(/2 balances, filling 2 days/)).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText('Balance column'), '1');
    expect(within(dialog).getByText(/No balances/)).toBeInTheDocument();
  });

  it("shows an import's progress on its account while it's written", async () => {
    server.use(http.get('*/api/accounts', () => HttpResponse.json({ accounts: ACCOUNTS.map((account) => (account.id === 'brk' ? { ...account, importProgress: { done: 3, total: 12 } } : account)) })));
    await openAccounts();
    expect(within(rowFor('Vanguard Brokerage')).getByText('Importing history… 3 of 12')).toBeInTheDocument();
  });
});
