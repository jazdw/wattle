import { describe, expect, it } from 'vitest';
import { csvAccounts, extractBalances, guessMapping, investmentKind, parseAmount, parseCsv, transactionsKind } from './csv';

// Made up: a bank's transaction export, newest first, several rows a day, a running balance.
const BANK = `Account,Date,Description,Debit,Credit,Balance,Category
000000123456,03/10/2026,"COFFEE, DOWNTOWN",4.50,,1995.50,OTHER
000000123456,03/10/2026,SALARY,,1000.00,2000.00,INCOME
000000123456,01/10/2026,RENT,600.00,,1000.00,OTHER
000000123456,28/09/2026,GROCERIES,50.00,,1600.00,OTHER
`;

describe('CSV import', () => {
  it('parses quoted fields', () => {
    expect(parseCsv(BANK)[1][2]).toBe('COFFEE, DOWNTOWN');
  });

  it('finds the date and balance columns and the date format, keeping each day’s closing balance', () => {
    const rows = parseCsv(BANK);
    const mapping = guessMapping(rows)!;
    // A day over 12 (the 28th) says the day comes first.
    expect(mapping).toEqual({ dateColumn: 1, balanceColumn: 5, dateFormat: 'DD/MM/YYYY', hasHeader: true });
    expect(extractBalances(rows, mapping).rows).toEqual([
      { date: '2026-09-28', balance: 1600 },
      { date: '2026-10-01', balance: 1000 },
      { date: '2026-10-03', balance: 1995.5 },
    ]);
  });

  it('guesses other date formats, and leaves files without a date and a balance column to be mapped by hand', () => {
    expect(guessMapping(parseCsv('Posted Date,Amount,Running Balance\n2026-10-01,5,100'))).toMatchObject({ dateColumn: 0, balanceColumn: 2, dateFormat: 'YYYY-MM-DD' });
    expect(guessMapping(parseCsv('Date,Balance\n10/13/2026,5'))).toMatchObject({ dateFormat: 'MM/DD/YYYY' });
    expect(guessMapping(parseCsv('when,amount\n01/02/2026,100'))).toBeNull();
  });

  it('parses amounts with symbols and parentheses', () => {
    expect(parseAmount('$1,234.50')).toBe(1234.5);
    expect(parseAmount('(12.00)')).toBe(-12);
    expect(parseAmount('')).toBeNull();
  });
});

describe('generic CSV', () => {
  it('handles other date formats, oldest-first files and bad rows', () => {
    const rows = parseCsv('when,amount\n01/02/2026,100\n01/03/2026,"1,050.00"\nnot a date,5\n01/03/2026,1100\n');
    const result = extractBalances(rows, { dateColumn: 0, balanceColumn: 1, dateFormat: 'MM/DD/YYYY', hasHeader: true });
    expect(result.skipped).toBe(1);
    // Oldest-first: the later row for Jan 3 is the closing balance.
    expect(result.rows).toEqual([
      { date: '2026-01-02', balance: 100 },
      { date: '2026-01-03', balance: 1100 },
    ]);
  });

  it('parses ISO dates and files without a header', () => {
    const rows = parseCsv('2026-10-01,5\r\n2026-10-02,6');
    expect(extractBalances(rows, { dateColumn: 0, balanceColumn: 1, dateFormat: 'YYYY-MM-DD', hasHeader: false }).rows).toHaveLength(2);
  });

  it('rejects impossible dates', async () => {
    const { parseDate } = await import('./csv');
    expect(parseDate('31/13/2026', 'DD/MM/YYYY')).toBeNull();
    expect(parseDate('5/6/26', 'DD/MM/YYYY')).toBe('2026-06-05');
  });
});

// Made up: a fund account's transaction export, with no balance or holdings in it.
const FUNDS = `Date,Type,Fund,Symbol,Shares,Price,Amount
1/05/2026,Buy,Example Total Market Fund,VTI,10.000,100.00,1000.00
2/05/2026,Buy,Example Plan Fund,,20.000,25.00,500.00
3/31/2026,Reinvested dividend,Example Total Market Fund,VTI,0.100,110.00,11.00
4/15/2026,Sell,Example Plan Fund,,5.000,26.00,130.00
`;
// Made up: a cash account's export: signed amounts, one pending.
const CASH = `Date,Description,Status,Amount
2026-09-01,Contribution,Processed,500.00
2026-09-15,Fund purchase,Processed,-200.00
2026-09-30,Interest,Processed,0.05
2026-10-01,Contribution,Pending,500.00
`;

describe('transactions CSV', () => {
  it('tells investments, cash and balances apart from the header', () => {
    expect(transactionsKind(FUNDS)).toBe('holdings');
    expect(transactionsKind(CASH)).toBe('cash');
    expect(transactionsKind('Date,Balance\n2026-01-01,5')).toBeNull();
  });

  it('reads investment transactions: kinds from the type, shares and cash signed by the kind, tickers from the symbol', () => {
    const account = csvAccounts(FUNDS)![0]!;
    expect(account).toMatchObject({ number: null, type: 'investment', unknownTypes: [] });
    expect(account.unanchored).toMatchObject({
      kind: 'holdings',
      moneyMoves: false,
      securities: [
        { id: 'VTI', ticker: 'VTI', name: 'Example Total Market Fund' },
        { id: 'Example Plan Fund', ticker: null, name: 'Example Plan Fund' },
      ],
    });
    expect(account.unanchored!.transactions.map(({ date, kind, security, shares, price, amount, value }) => ({ date, kind, security, shares, price, amount, value }))).toEqual([
      { date: '2026-01-05', kind: 'buy', security: 'VTI', shares: 10, price: 100, amount: -1000_00, value: 1000_00 },
      { date: '2026-02-05', kind: 'buy', security: 'Example Plan Fund', shares: 20, price: 25, amount: -500_00, value: 500_00 },
      { date: '2026-03-31', kind: 'reinvest', security: 'VTI', shares: 0.1, price: 110, amount: 0, value: 11_00 },
      { date: '2026-04-15', kind: 'sell', security: 'Example Plan Fund', shares: -5, price: 26, amount: 130_00, value: 130_00 },
    ]);
  });

  it('reads cash transactions by their sign, leaving out pending ones', () => {
    const account = csvAccounts(CASH)![0]!;
    expect(account.unanchored!.transactions.map(({ date, kind, amount }) => ({ date, kind, amount }))).toEqual([
      { date: '2026-09-01', kind: 'deposit', amount: 500_00 },
      { date: '2026-09-15', kind: 'withdrawal', amount: -200_00 },
      { date: '2026-09-30', kind: 'income', amount: 5 },
    ]);
    // Debits and credits in their own columns.
    const split = csvAccounts('Date,Debit,Credit\n2026-09-01,,100\n2026-09-02,40,')![0]!;
    expect(split.unanchored!.transactions.map((txn) => txn.amount)).toEqual([100_00, -40_00]);
  });

  it("lists types it doesn't know, and stops at a row it can't read", () => {
    expect(csvAccounts('Date,Type,Fund,Shares,Amount\n2026-01-05,Merger,Example Fund,10,100')![0]!.unknownTypes).toEqual(['Merger']);
    expect(() => csvAccounts('Date,Amount\n2026-01-05,100\nsoon,5')![0]).toThrow(/Row 3 of the CSV has no date/);
  });

  it('names investment kinds from common wording', () => {
    expect(investmentKind('Purchase of shares', 1, 100)).toBe('buy');
    expect(investmentKind('Dividend', 0, 5)).toBe('income');
    expect(investmentKind('Dividend', 0.1, 5)).toBe('reinvest');
    expect(investmentKind('Earnings', 0.1, 5)).toBe('reinvest');
    expect(investmentKind('Fee', 0.1, 5)).toBe('sell'); // a plan's fee sells shares
    expect(investmentKind('', -2, 50)).toBe('sell');
    expect(investmentKind('Something else', 1, 1)).toBeNull();
  });
});

// Made up: a download with two tables, holdings now and then transactions, for two accounts.
const TWO_TABLES = `Account Number,Investment Name,Symbol,Shares,Share Price,Total Value
11112222,EXAMPLE MONEY MARKET,EXMXX,250,1,250
11112222,Example Total Market ETF,VTI,12,100,1200
33334444,EXAMPLE CASH ACCOUNT,null,75,1,75

Account Number,Trade Date,Transaction Type,Transaction Description,Investment Name,Symbol,Shares,Share Price,Net Amount
11112222,2026-03-02,Funds Received,Deposit,EXAMPLE MONEY MARKET,EXMXX,0,1,1000
11112222,2026-03-02,Sweep in,Sweep,EXAMPLE MONEY MARKET,EXMXX,0,1,1000
11112222,2026-03-03,Buy,Buy,Example Total Market ETF,VTI,10,100,-1000
11112222,2026-03-31,Dividend,Dividend,Example Total Market ETF,VTI,0,0,20
11112222,2026-03-31,Reinvestment,Reinvestment,Example Total Market ETF,VTI,0.2,100,-20
11112222,2026-04-01,Buy,Buy,Example Total Market ETF,VTI,1.8,100,-180
33334444,2026-03-31,Interest,Interest,,null,0,0,5
33334444,2026-03-31,Reinvestment,Reinvestment,,null,0,0,-5
`;

describe('CSV tables', () => {
  it('reads each table of a download, an account per account number, holdings now as what it holds', () => {
    const [brokerage, cash] = csvAccounts(TWO_TABLES)!;
    expect(brokerage).toMatchObject({ number: '11112222', type: 'investment' });
    expect(brokerage.unanchored).toBeUndefined();
    // The $1 fund cash is swept into is the cash; the rest are holdings.
    expect(brokerage.file).toMatchObject({ kind: 'holdings', cash: 250_00, positions: [{ security: 'VTI', shares: 12, price: 100 }], securities: [{ id: 'VTI', ticker: 'VTI', name: 'Example Total Market ETF' }] });
    expect(brokerage.file.kind === 'holdings' && brokerage.file.transactions.map(({ kind, security, shares, amount }) => ({ kind, security, shares, amount }))).toEqual([
      { kind: 'deposit', security: null, shares: 0, amount: 1000_00 },
      { kind: 'sweep', security: null, shares: 0, amount: 0 },
      { kind: 'buy', security: 'VTI', shares: 10, amount: -1000_00 },
      { kind: 'income', security: null, shares: 0, amount: 20_00 },
      // Paid for by the dividend listed beside it.
      { kind: 'reinvest', security: 'VTI', shares: 0.2, amount: -20_00 },
      { kind: 'buy', security: 'VTI', shares: 1.8, amount: -180_00 },
    ]);
    // A $1 holding with no symbol is the cash; interest reinvested in it stays in it.
    expect(cash.file).toMatchObject({ kind: 'holdings', cash: 75_00, positions: [] });
    expect(cash.file.kind === 'holdings' && cash.file.transactions.map(({ kind, amount }) => ({ kind, amount }))).toEqual([
      { kind: 'income', amount: 5_00 },
      { kind: 'sweep', amount: 0 },
    ]);
  });

  it('reads a table of holdings on its own as an account with nothing yet to work back through', () => {
    const [account] = csvAccounts('Fund,Shares,Last trade date,Last trade price\nExample Plan Fund,40,1/05/2026,25.00')!;
    expect(account.file).toMatchObject({ kind: 'holdings', positions: [{ security: 'Example Plan Fund', shares: 40, price: 25 }], transactions: [] });
    expect(account.unanchored).toBeUndefined();
  });
});

