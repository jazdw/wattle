import { describe, expect, it } from 'vitest';
import type { ImportedHoldings } from '../../shared/schemas';
import { mergeAccounts, readFiles, type FileAccount } from './imports';
import { buy, sgml } from '../test/ofx';

const holdings = (account: FileAccount) => account.file as ImportedHoldings;

describe('readFiles', () => {
  it('counts a transaction in overlapping downloads once, with positions from the latest', () => {
    const older = sgml(buy('B1', '20250803', '10', '12.5', '125.00'), '20251231');
    const newer = sgml(buy('B1', '20250803', '10', '12.5', '125.00') + buy('B2', '20260803', '10', '12.5', '125.00'));
    const read = readFiles([newer, older]);
    if (read.kind !== 'accounts') throw new Error('expected accounts');
    expect(read.accounts).toHaveLength(1);
    expect(holdings(read.accounts[0]).transactions.map((txn) => txn.date)).toEqual(['2025-08-03', '2026-08-03']);
    expect(holdings(read.accounts[0]).asOf).toBe('2026-10-08');
  });

  it('keeps each account in a download with several', () => {
    const one = sgml(buy('B1', '20260803', '10', '12.5', '125.00'));
    const statement = one.slice(one.indexOf('<INVSTMTTRNRS>'), one.indexOf('</INVSTMTMSGSRSV1>'));
    const both = one.replace('</INVSTMTMSGSRSV1>', statement.replace('<ACCTID>12345678', '<ACCTID>87654321') + '</INVSTMTMSGSRSV1>');
    const read = readFiles([both]);
    expect(read.kind === 'accounts' && read.accounts.map((account) => account.number)).toEqual(['12345678', '87654321']);
  });

  it('gives a CSV of balances its columns to choose, on its own', () => {
    const read = readFiles(['Account,Date,Description,Debit,Credit,Balance\n1,03/10/2026,x,,1,5']);
    expect(read).toMatchObject({ kind: 'table', guess: { dateColumn: 1, balanceColumn: 5 } });
    expect(() => readFiles(['Date,Balance\n2026-01-01,5', sgml('')])).toThrow(/imported on its own/);
  });
});

describe('mergeAccounts', () => {
  const account = (transactions: Partial<ImportedHoldings['transactions'][number]>[], asOf = '2026-10-01'): FileAccount => ({
    number: '1234',
    institution: null,
    unknownTypes: [],
    file: {
      kind: 'holdings',
      asOf,
      securities: [],
      positions: [],
      cash: 0,
      transactions: transactions.map((txn) => ({ date: '2026-06-01', kind: 'buy', label: 'Buy', security: 'VTI', shares: 1, price: 100, amount: -100_00, value: 100_00, charges: 0, ...txn })),
    },
  });

  it('without ids, keeps as many identical transactions as the file with the most', () => {
    const merged = mergeAccounts([[account([{}, {}])], [account([{}, { date: '2026-07-01' }], '2026-10-05')]]);
    expect(holdings(merged[0]).transactions.map((txn) => txn.date)).toEqual(['2026-06-01', '2026-06-01', '2026-07-01']);
    expect(holdings(merged[0]).asOf).toBe('2026-10-05');
  });

  it('refuses files that disagree on the currency', () => {
    const aud = { ...account([]), file: { ...account([]).file, currency: 'AUD' } as ImportedHoldings };
    expect(() => mergeAccounts([[account([])], [aud]])).toThrow(/different currencies/);
  });
});
