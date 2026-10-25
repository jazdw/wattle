import { describe, expect, it } from 'vitest';
import { extractBalances, parseAmount, parseCsv, PRESETS, vanguardBalances } from './csv';

const BANK_EXPORT = `Bank Account,Date,Description,Debit Amount,Credit Amount,Balance,Category,Reference
000000123456,03/10/2026,"COFFEE, DOWNTOWN",4.50,,1995.50,OTHER,
000000123456,03/10/2026,SALARY,,1000.00,2000.00,INCOME,
000000123456,01/10/2026,RENT,600.00,,1000.00,OTHER,
`;

describe('CSV import', () => {
  it('parses quoted fields', () => {
    expect(parseCsv(BANK_EXPORT)[1][2]).toBe('COFFEE, DOWNTOWN');
  });

  it('detects Example Bank and keeps each day’s closing balance', () => {
    const rows = parseCsv(BANK_EXPORT);
    const preset = PRESETS.find((candidate) => candidate.detect(rows[0]))!;
    expect(preset.id).toBe('examplebank');
    const result = extractBalances(rows, preset.mapping(rows[0]));
    expect(result.rows).toEqual([
      { date: '2026-10-01', balance: 1000 },
      { date: '2026-10-03', balance: 1995.5 },
    ]);
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

// Made up: a cash account (money market fund and cash) and a stock account.
const VANGUARD = `Account Number,Investment Name,Symbol,Shares,Share Price,Total Value,
12345678,EXAMPLE MONEY MARKET FUND,XYZMM,9000.00,1,9000.00,
12345678,CASH,null,25.00,1,25.00,
87654321,VANGUARD TOTAL STOCK MARKET ETF,VTI,10,300.00,3000.00,



Account Number,Trade Date,Settlement Date,Transaction Type,Transaction Description,Investment Name,Symbol,Shares,Share Price,Principal Amount,Commissions and Fees,Net Amount,Accrued Interest,Account Type,
12345678,2026-04-15,2026-04-15,Withdrawal,Electronic Funds Transfer,CASH,,0.00000,1.0,-1000.00,0.0,-1000.00,0.0,CASH,
12345678,2026-03-31,2026-03-31,Reinvestment,Dividend Reinvestment,EXAMPLE MONEY MARKET FUND,XYZMM,25.00000,1.0,-25.00,0.0,-25.00,0.0,CASH,
12345678,2026-03-31,2026-03-31,Dividend,Dividend Received,EXAMPLE MONEY MARKET FUND,XYZMM,0.00000,1.0,25.00,0.0,25.00,0.0,CASH,
12345678,2026-03-02,2026-03-02,Sweep in,Sweep Into Settlement Fund,CASH,,0.00000,1.0,-10000.00,0.0,-10000.00,0.0,CASH,
12345678,2026-03-02,2026-03-02,Deposit,Electronic Funds Transfer,CASH,,0.00000,1.0,10000.00,0.0,10000.00,0.0,CASH,
87654321,2026-03-10,2026-03-10,Buy,Buy,VANGUARD TOTAL STOCK MARKET ETF,VTI,10.00000,300.0,-3000.00,0.0,-3000.00,0.0,CASH,
`;

describe('Vanguard download', () => {
  it('rebuilds a cash account\'s balances from today\'s total and its money in and out, leaving out accounts with priced holdings', () => {
    const rows = parseCsv(VANGUARD);
    const preset = PRESETS.find((candidate) => candidate.detect(rows[0]));
    expect(preset?.id).toBe('vanguard');
    const table = preset!.transform!(rows);
    // Sweeps and reinvestments move money within the account; the stock account isn't rebuilt.
    expect(table).toEqual([
      ['Date', 'Account ending 5678'],
      ['2026-03-01', '0.00'],
      ['2026-03-02', '10000.00'],
      ['2026-03-31', '10025.00'],
      ['2026-04-15', '9025.00'],
    ]);
    expect(extractBalances(table, preset!.mapping(table[0])).rows.at(-1)).toEqual({ date: '2026-04-15', balance: 9025 });
  });

  it('gives nothing to import without a cash account or transactions', () => {
    expect(vanguardBalances(parseCsv(VANGUARD.replace(/12345678/g, '87654321')))).toEqual([]);
    expect(vanguardBalances(parseCsv(VANGUARD.split('\n\n\n\n')[0]))).toEqual([]);
  });
});
