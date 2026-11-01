import { describe, expect, it } from 'vitest';
import { extractBalances, guessMapping, parseAmount, parseCsv } from './csv';

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
