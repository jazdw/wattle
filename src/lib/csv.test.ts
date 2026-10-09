import { describe, expect, it } from 'vitest';
import { extractBalances, parseAmount, parseCsv, PRESETS } from './csv';

const WESTPAC = `Bank Account,Date,Narrative,Debit Amount,Credit Amount,Balance,Categories,Serial
032000123456,03/10/2026,"COFFEE, SYDNEY",4.50,,1995.50,OTHER,
032000123456,03/10/2026,SALARY,,1000.00,2000.00,INCOME,
032000123456,01/10/2026,RENT,600.00,,1000.00,OTHER,
`;

describe('CSV import', () => {
  it('parses quoted fields', () => {
    expect(parseCsv(WESTPAC)[1][2]).toBe('COFFEE, SYDNEY');
  });

  it('detects Westpac and keeps each day’s closing balance', () => {
    const rows = parseCsv(WESTPAC);
    const preset = PRESETS.find((candidate) => candidate.detect(rows[0]))!;
    expect(preset.id).toBe('westpac');
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
