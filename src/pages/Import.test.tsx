import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { ACCOUNTS } from '../test/fixtures';
import { bankSgml, buy, fee, sgml, sgmlAccounts } from '../test/ofx';
import { renderPage } from '../test/render';
import { sent, server } from '../test/server';
import { localDateTime } from '../lib/format';
import { Import } from './Import';

describe('Import page', () => {
  // Made up: a bank's transaction export, newest first, with a running balance.
  const bank = `Account,Date,Description,Debit,Credit,Balance,Category
000000123456,03/10/2026,COFFEE,4.50,,1995.50,OTHER
000000123456,03/10/2026,SALARY,,1000.00,2000.00,INCOME
000000123456,01/10/2026,RENT,600.00,,1000.00,OTHER
000000123456,28/09/2026,GROCERIES,50.00,,1600.00,OTHER
`;
  const upload = (...contents: string[]) =>
    fireEvent.change(screen.getByLabelText('Files'), { target: { files: contents.map((content, index) => new File([content], `file${index}`, { type: 'text/plain' })) } });
  async function openImport() {
    const opened = renderPage(<Import checkDelay={0} />);
    // Your accounts loaded, to match the files' accounts against.
    await waitFor(() => expect(sent('GET /api/accounts')).not.toHaveLength(0));
    await waitFor(() => expect(opened.queryClient.getQueryState(['accounts', 'USD'])?.status).toBe('success'));
    return opened;
  }
  const accepted = { accounts: [] };
  /** The server finds nothing wrong. */
  const checked = (problems: unknown[] = [], warnings: unknown[] = []) => server.use(http.post('*/api/imports/check', () => HttpResponse.json({ accounts: [], problems, warnings })));
  /** Import, once the check has run. */
  async function importIt(user: ReturnType<typeof renderPage>['user']) {
    const button = screen.getByRole('button', { name: 'Import' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
  }

  /** Marks every security the files name without a ticker as having no market price (a blank ticker isn't a choice). */
  async function noMarketPrice(user: ReturnType<typeof renderPage>['user']) {
    for (const toggle of await screen.findAllByLabelText(/has no market price/)) await user.click(toggle);
  }

  it('finds the date and balance columns of a CSV, previews and imports daily balances, then shows what was imported', async () => {
    server.use(http.post('*/api/imports', () => HttpResponse.json(accepted)));
    checked();
    const { user } = await openImport();
    upload(bank);

    expect(await screen.findByText(/Found its date and balance columns/)).toBeInTheDocument();
    // The 28th says the day comes first. The import carries each balance to the next, so 3 balances fill 6 days.
    expect(screen.getByText(/3 balances, filling 6 days/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled(); // no account chosen
    await user.selectOptions(screen.getByLabelText('Import The file into'), 'wbc');
    await importIt(user);

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
    // Accepted: what was imported; importing more starts afresh.
    expect(await screen.findByText('Imported')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Import more files' }));
    expect(screen.getByLabelText('Files')).toBeInTheDocument();
    expect(screen.queryByText(/Found its/)).not.toBeInTheDocument();
  });

  it('imports every account in a download: matched by last digits, new, or skipped', async () => {
    server.use(http.get('*/api/accounts', () => HttpResponse.json({ accounts: ACCOUNTS.map((account) => (account.id === 'brk' ? { ...account, mask: '4321' } : account)) })));
    server.use(http.post('*/api/imports/tickers', () => HttpResponse.json({ suggestions: [] })));
    server.use(http.post('*/api/imports', () => HttpResponse.json(accepted)));
    checked();
    const { user } = await openImport();
    // A brokerage you've linked (mask 4321), an account you haven't, and one sharing a linked checking account's last digits.
    upload(sgmlAccounts(['55554321', '66665678', '77771234']));

    // The brokerage is matched by its last digits; the others wait for a choice.
    expect(await screen.findByLabelText('Import ··4321 into')).toHaveValue('brk');
    expect(screen.getAllByText(/1 holding, 1 transaction/)).toHaveLength(3);
    expect(screen.getByLabelText('Import ··5678 into')).toHaveValue('choose');
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();

    await user.selectOptions(screen.getByLabelText('Import ··5678 into'), 'new');
    // Named by its kind (the file doesn't say which: investments), its institution beside it.
    expect(screen.getByLabelText("New account's name")).toHaveValue('Investments');
    expect(screen.getByLabelText('Institution')).toHaveValue('Example Plan');
    // ··1234 is the linked checking account's last digits: a new account would count it twice.
    await user.selectOptions(screen.getByLabelText('Import ··1234 into'), 'new');
    expect(screen.getByText(/is linked with the same last digits/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Import ··1234 into'), 'skip');
    // The fund the file names without a ticker: left blank, it has to be marked as having no market price.
    expect(await screen.findByText(/a ticker or mark it as having no market price/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
    await noMarketPrice(user);
    await importIt(user);

    await expect.poll(() => sent('POST /api/imports')[0]?.body).toMatchObject({
      accounts: [
        { label: '··4321', target: { accountId: 'brk' }, file: { kind: 'holdings', positions: [{ security: '000000002', shares: 260, price: 13 }] } },
        { label: '··5678', target: { new: { name: 'Investments', type: 'investment', subtype: null, currency: 'USD', institutionName: 'Example Plan', mask: '5678', ownerUserId: 'u-me' } } },
      ],
    });
    expect(await screen.findByText('Imported')).toBeInTheDocument();
  });

  it('imports a card download into a new credit card account', async () => {
    server.use(http.post('*/api/imports', () => HttpResponse.json(accepted)));
    checked();
    const { user } = await openImport();
    upload(bankSgml([['20260915', '-100.00']], '-300.00', { card: true, number: '99995555' }));
    await user.selectOptions(await screen.findByLabelText('Import ··5555 into'), 'new');
    expect(screen.getByLabelText('Type')).toHaveValue('credit');
    // Newest first: the statement's closing balance and the opening one worked back to its start, which have no change, say which they are.
    expect(screen.getAllByRole('row').slice(1).map((row) => row.textContent)).toEqual(['Oct 8, 2026Closing balance$300.00', 'Sep 15, 2026$100.00$300.00', 'Sep 1, 2026Opening balance$200.00']);
    // The file's institution, to correct.
    expect(screen.getByLabelText('Institution')).toHaveValue('Example Bank');
    await user.clear(screen.getByLabelText('Institution'));
    await user.type(screen.getByLabelText('Institution'), 'Example Card Co');
    await importIt(user);
    await expect.poll(() => sent('POST /api/imports')[0]?.body).toMatchObject({
      accounts: [{ label: '··5555', target: { new: { name: 'Credit card', institutionName: 'Example Card Co', type: 'credit', subtype: 'credit card', currency: 'USD' } }, file: { kind: 'balances', currency: 'USD', rows: [{ date: '2026-09-01', balance: 200 }, { date: '2026-09-15', balance: 300 }, { date: '2026-10-08', balance: 300 }] } }],
    });
  });

  it("shows each file's days and balance, and takes the ending balance from the account's balance Wattle has that day when the file's is later", async () => {
    server.use(
      http.post('*/api/imports', () => HttpResponse.json(accepted)),
      // The account already has the file's last day (a later year's file imported first): $250.00 owed.
      http.get('*/api/accounts/card/balances', ({ request }) => HttpResponse.json({ balances: new URL(request.url).searchParams.get('on') === '2026-01-01' ? [{ date: '2026-01-01', balance: -250_00, source: 'import' }] : [] })),
    );
    checked();
    const { user } = await openImport();
    // A year's statement whose balance is from the day it was downloaded, long after.
    upload(bankSgml([['20251120', '-250.00']], '-6000.00', { card: true, number: '99995555', start: '20250101', end: '20260101', asOf: '20261008' }));
    await user.selectOptions(await screen.findByLabelText('Import ··5555 into'), 'card');
    expect(screen.getByText(/Transactions Jan 1, 2025 – Jan 1, 2026 · 1 transaction/)).toBeInTheDocument();
    // When it's from, in the browser's time zone (noon GMT in the file).
    expect(screen.getByText(`Its balance $6,000.00 as of ${localDateTime('2026-10-08T12:00:00.000Z')}, after its transactions end, so not used`)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Ending balance, Jan 1, 2026')).toHaveValue('250.00'));
    expect(screen.getByText(/Wattle’s balance on Jan 1, 2026, from an earlier import/)).toBeInTheDocument();
    // The other, worked out through its transaction: nothing, so it starts the day before.
    expect(screen.getByLabelText('Starting balance, Nov 19, 2025')).toHaveValue('0.00');
    expect(screen.getByText(/Nothing before its first transaction, so it starts the day before/)).toBeInTheDocument();
    await importIt(user);
    await expect.poll(() => sent('POST /api/imports')[0]?.body).toMatchObject({
      accounts: [{ target: { accountId: 'card' }, file: { kind: 'balances', rows: [{ date: '2025-11-19', balance: 0 }, { date: '2025-11-20', balance: 250 }, { date: '2026-01-01', balance: 250 }] } }],
    });
  });

  it('assumes a starting balance of nothing when neither the file nor Wattle has one, and takes either you change', async () => {
    server.use(http.post('*/api/imports', () => HttpResponse.json(accepted)));
    // Balances differing from Wattle's are said, without stopping the import.
    checked([], [{ label: '··5555', date: '2025-11-20', text: 'On 2025-11-20, this works out $300.00 where Wattle has $250.00 from the institution: transactions may be missing, or the starting or ending balance is wrong.' }]);
    const { user } = await openImport();
    upload(bankSgml([['20251120', '-250.00']], '-6000.00', { card: true, number: '99995555', start: '20250101', end: '20260101', asOf: '20261008' }));
    await user.selectOptions(await screen.findByLabelText('Import ··5555 into'), 'card');
    await waitFor(() => expect(screen.getByLabelText('Starting balance, Nov 19, 2025')).toHaveValue('0.00'));
    expect(screen.getByText(/Assumed: Wattle has no balance for this account before Jan 1, 2025/)).toBeInTheDocument();
    expect(screen.getByLabelText('Ending balance, Jan 1, 2026')).toHaveValue('250.00');
    // Changing the ending balance works the start out from it.
    await user.clear(screen.getByLabelText('Ending balance, Jan 1, 2026'));
    await user.type(screen.getByLabelText('Ending balance, Jan 1, 2026'), '300');
    expect(screen.getByLabelText('Starting balance, Jan 1, 2025')).toHaveValue('50.00');
    expect(screen.getAllByText('Entered by you.')).toHaveLength(1);
    expect(await screen.findByText(/works out \$300.00 where Wattle has \$250.00 from the institution/)).toBeInTheDocument();
    await importIt(user);
    await expect.poll(() => sent('POST /api/imports')[0]?.body).toMatchObject({ accounts: [{ file: { rows: [{ date: '2025-01-01', balance: 50 }, { date: '2025-11-20', balance: 300 }, { date: '2026-01-01', balance: 300 }] } }] });
  });

  it('works out a CSV of transactions from a balance you give, at its start or end', async () => {
    server.use(http.post('*/api/imports', () => HttpResponse.json(accepted)));
    checked();
    const { user } = await openImport();
    // Made up: a cash export with no balance in it.
    upload('Date,Description,Amount\n2026-09-01,Contribution,500.00\n2026-09-15,Purchase,-200.00');
    expect(await screen.findByText(/2 transactions · Sep 1, 2026 – Sep 15, 2026/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Import file0 into'), 'wbc');
    // None known: nothing assumed at the start, to change.
    await waitFor(() => expect(screen.getByLabelText('Starting balance, Aug 31, 2026')).toHaveValue('0.00'));

    // $1,000 before the first transaction.
    await user.clear(screen.getByLabelText(/^Starting balance/));
    await user.type(screen.getByLabelText(/^Starting balance/), '1000');
    expect(screen.getByLabelText('Starting balance, Sep 1, 2026')).toHaveValue('1000');
    await importIt(user);
    await expect.poll(() => sent('POST /api/imports')[0]?.body).toEqual({
      accounts: [
        {
          label: 'file0',
          target: { accountId: 'wbc' },
          file: {
            kind: 'balances',
            rows: [{ date: '2026-08-31', balance: 1000 }, { date: '2026-09-01', balance: 1500 }, { date: '2026-09-15', balance: 1300 }],
            // Its transactions go too, to be kept as the account's.
            transactions: [
              { date: '2026-09-01', kind: 'deposit', label: 'Contribution', description: 'Contribution', amount: 500_00 },
              { date: '2026-09-15', kind: 'withdrawal', label: 'Purchase', description: 'Purchase', amount: -200_00 },
            ],
          },
        },
      ],
    });
  });

  it("won't import an account with transaction types it doesn't understand, until it's skipped", async () => {
    server.use(http.post('*/api/imports/tickers', () => HttpResponse.json({ suggestions: [] })));
    checked();
    const expense = `<INVEXPENSE><INVTRAN><FITID>E1</FITID><DTTRADE>20260901</DTTRADE></INVTRAN><SECID><UNIQUEID>000000002</UNIQUEID><UNIQUEIDTYPE>CUSIP</UNIQUEIDTYPE></SECID><TOTAL>5.00</TOTAL><SUBACCTSEC>CASH</SUBACCTSEC><SUBACCTFUND>CASH</SUBACCTFUND></INVEXPENSE>`;
    const { user } = await openImport();
    upload(sgmlAccounts(['55551111', '66665678'], { '55551111': expense }));
    await user.selectOptions(await screen.findByLabelText('Import ··1111 into'), 'new');
    expect(screen.getByText(/doesn't understand these transaction types yet: INVEXPENSE/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Import ··5678 into'), 'new');
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Import ··1111 into'), 'skip');
    await noMarketPrice(user);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled());
  });

  it('suggests a ticker for a security the file names without one, and sends what you choose', async () => {
    server.use(http.post('*/api/imports/tickers', () => HttpResponse.json({ suggestions: [{ id: '000000002', ticker: 'XYZ', from: 'search', exact: false }] })));
    server.use(http.post('*/api/imports', () => HttpResponse.json(accepted)));
    checked();
    const { user } = await openImport();
    upload(sgml(buy('B1', '20260803', '10', '12.5', '125.00')));
    const ticker = await screen.findByLabelText('Ticker for Example S&P Index Fund M');
    await expect.poll(() => (ticker as HTMLInputElement).value).toBe('XYZ');
    // Filled in, but only a similar name: to check.
    expect(screen.getByText(/a similar name: check it/)).toBeInTheDocument();

    await user.clear(ticker);
    await user.type(ticker, 'not a ticker');
    await user.selectOptions(screen.getByLabelText('Import ··5678 into'), 'new');
    expect(screen.getByText(/That isn't a ticker/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
    await user.clear(ticker);
    await user.type(ticker, 'abc');
    await importIt(user);
    await expect.poll(() => (sent('POST /api/imports')[0]?.body as { accounts: { file: { securities: unknown[] } }[] })?.accounts[0].file.securities).toEqual([
      { id: '000000002', ticker: 'ABC', name: 'Example S&P Index Fund M' },
    ]);
  });

  it("says when the ticker search isn't available, and imports once you type the ticker", async () => {
    server.use(http.post('*/api/imports/tickers', () => HttpResponse.json({ suggestions: [], unavailable: true })));
    server.use(http.post('*/api/imports', () => HttpResponse.json(accepted)));
    checked();
    const { user } = await openImport();
    upload(sgml(buy('B1', '20260803', '10', '12.5', '125.00')));
    expect(await screen.findByText(/ticker search isn't available right now/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Import ··5678 into'), 'new');
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
    await user.type(screen.getByLabelText('Ticker for Example S&P Index Fund M'), 'xyz');
    await importIt(user);
    await expect.poll(() => (sent('POST /api/imports')[0]?.body as { accounts: { file: { securities: unknown[] } }[] })?.accounts[0].file.securities).toEqual([
      { id: '000000002', ticker: 'XYZ', name: 'Example S&P Index Fund M' },
    ]);
  });

  it('lets you map columns for other files', async () => {
    const { user } = await openImport();
    upload('when,note,amount\n01/02/2026,x,100\n01/03/2026,y,105\n');
    expect(await screen.findByText(/Choose the columns with the date and the balance/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Date format'), 'MM/DD/YYYY');
    expect(screen.getByText(/2 balances, filling 2 days/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Balance column'), '1');
    expect(screen.getByText(/No balances/)).toBeInTheDocument();
    });

  it("previews every row the import writes, with the cash and shares after each, and blocks it on the server's problems, marking their days", async () => {
    server.use(http.post('*/api/imports/tickers', () => HttpResponse.json({ suggestions: [] })));
    server.use(
      http.post('*/api/imports/check', () =>
        HttpResponse.json({ accounts: [{ label: '··5678', created: true, days: 70, from: '2026-08-03', to: '2026-10-08', estimated: [], closes: [{ date: '2026-08-03', security: '000000002', close: 12.4 }] }], problems: [{ label: '··5678', date: '2026-08-03', text: 'on 2026-08-03, XYZ traded at 12.5 but closed at 10' }] }),
      ),
    );
    const { user } = await openImport();
    upload(sgml(buy('B1', '20260803', '10', '12.5', '125.00') + fee));
    await user.selectOptions(await screen.findByLabelText('Import ··5678 into'), 'new');

    // Newest first: the fee's sale, then the purchase, each with the shares held after it (260 now).
    const rows = () => screen.getAllByRole('row').slice(1).map((row) => row.textContent);
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toMatch(/Aug 17, 2026.*Sale.*Fees.*-0\.08.*260/);
    expect(rows()[1]).toMatch(/Aug 3, 2026.*Purchase.*Contributions.*10.*12\.50.*260\.08/);

    expect(await screen.findByText('On 2026-08-03, XYZ traded at 12.5 but closed at 10.')).toBeInTheDocument();
    expect(screen.getAllByRole('row')[2].className).toMatch(/bg-negative/);
    expect(rows()[1]).toMatch(/12\.40/); // the day's close beside the trade
    expect(screen.getByRole('status')).toHaveTextContent('1 problem to fix before importing.');
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
  });

  it('combines files of one account that have no account number, such as a CSV a year', async () => {
    server.use(http.post('*/api/imports/tickers', () => HttpResponse.json({ suggestions: [] })));
    server.use(http.post('*/api/imports', () => HttpResponse.json(accepted)));
    checked();
    const { user } = await openImport();
    // Made up: a cash account's exports, one a year, with no balance in them.
    upload('Date,Description,Amount\n2025-06-01,Contribution,500.00', 'Date,Description,Amount\n2026-06-01,Contribution,300.00');
    await user.selectOptions(await screen.findByLabelText('Import file1 into'), 'with:0');
    expect(screen.getByText(/Imported together with that file/)).toBeInTheDocument();
    expect(screen.getByText(/Choose where file0 goes/)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Import file0 into'), 'wbc');
    // One known balance for both: $1,000 after the last.
    await waitFor(() => expect(screen.getByLabelText('Ending balance, Jun 1, 2026')).toHaveValue('800.00'));
    await user.clear(screen.getByLabelText('Ending balance, Jun 1, 2026'));
    await user.type(screen.getByLabelText('Ending balance, Jun 1, 2026'), '1000');
    await importIt(user);
    await expect.poll(() => sent('POST /api/imports')[0]?.body).toEqual({
      accounts: [
        {
          label: 'file0',
          target: { accountId: 'wbc' },
          file: {
            kind: 'balances',
            rows: [{ date: '2025-06-01', balance: 700 }, { date: '2026-06-01', balance: 1000 }],
            transactions: [
              { date: '2025-06-01', kind: 'deposit', label: 'Contribution', description: 'Contribution', amount: 500_00 },
              { date: '2026-06-01', kind: 'deposit', label: 'Contribution', description: 'Contribution', amount: 300_00 },
            ],
          },
        },
      ],
    });
  });

  it('checks an account as soon as it has somewhere to go, before the others do', async () => {
    server.use(http.post('*/api/imports/tickers', () => HttpResponse.json({ suggestions: [] })));
    checked();
    const { user } = await openImport();
    upload(sgmlAccounts(['55551111', '66665678']));
    await user.selectOptions(await screen.findByLabelText('Import ··1111 into'), 'new');
    // Only the placed one is checked; Import waits for the other.
    await expect.poll(() => (sent('POST /api/imports/check').at(-1)?.body as { accounts: { label: string }[] } | undefined)?.accounts.map((account) => account.label)).toEqual(['··1111']);
    expect(await screen.findByText(/Checked so far/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Import ··5678 into'), 'skip');
    await noMarketPrice(user);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled());
  });
});
