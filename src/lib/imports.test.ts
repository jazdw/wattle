import { describe, expect, it } from 'vitest';
import type { ImportedHoldings } from '../../shared/schemas';
import { combineAccounts, mergeAccounts, readFiles, type FileAccount } from './imports';
import { csvAccounts } from './csv';
import { withKnown } from './known';
import { bankSgml, buy, sgml } from '../test/ofx';

const holdings = (account: FileAccount) => account.file as ImportedHoldings;

describe('readFiles', () => {
  it('counts a transaction in overlapping downloads once, with positions from the latest', () => {
    const older = sgml(buy('B1', '20250803', '10', '12.5', '125.00'), '20251120');
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

  /** The account's days, from a balance known at its start or end (the import page fills one in). */
  const worked = (account: FileAccount, at: 'start' | 'end', cash: number) => withKnown(account, { at, cash, shares: {} })?.file;

  it('reads bank downloads beside investment ones, overlapping statements of one account as one', () => {
    const older = bankSgml([['20260910', '500.00']], '700.00', { asOf: '20260915' });
    const newer = bankSgml([['20260910', '500.00'], ['20261001', '-100.00']], '600.00');
    const read = readFiles([older, newer, sgml(buy('B1', '20260803', '10', '12.5', '125.00'))], ['older.qfx', 'newer.qfx', 'funds.qfx']);
    if (read.kind !== 'accounts') throw new Error('expected accounts');
    expect(read.accounts.map((account) => [account.number, account.unanchored?.kind ?? account.file.kind])).toEqual([['99990001', 'cash'], ['12345678', 'holdings']]);
    const [bank] = read.accounts;
    // Each file's days and balance, by name; the newest balance is the ending one, dated where the transactions end.
    expect(bank.statement?.files.map((file) => [file.name, file.from, file.to, file.count, file.balance, file.asOf])).toEqual([
      ['older.qfx', '2026-09-01', '2026-09-15', 1, 700_00, '2026-09-15'],
      ['newer.qfx', '2026-09-01', '2026-10-08', 2, 600_00, '2026-10-08'],
    ]);
    expect(bank.unanchored).toMatchObject({ from: '2026-09-01', to: '2026-10-08', fileBalance: { amount: 600, asOf: '2026-10-08', atEnd: true } });
    expect(bank.unanchored?.transactions).toHaveLength(2);
    expect(worked(bank, 'end', 600)).toMatchObject({ rows: [{ date: '2026-09-01', balance: 200 }, { date: '2026-09-10', balance: 700 }, { date: '2026-10-01', balance: 600 }, { date: '2026-10-08', balance: 600 }] });
  });

  it("works a card's statements of different years from either end, the same in any order", () => {
    // Each statement's balance is the day it was downloaded, whatever year it covers: $600 owed.
    const card = { card: true, number: '99995555', asOf: '20261008' };
    const empty = bankSgml([], '-600.00', { ...card, start: '20241001', end: '20250101', ids: 'A' });
    const year = bankSgml([['20251120', '-100.00']], '-600.00', { ...card, start: '20250101', end: '20260101', ids: 'B' });
    const recent = bankSgml([['20260105', '-700.00'], ['20260301', '200.00']], '-600.00', { ...card, start: '20260101', ids: 'C' });
    const read = readFiles([empty, year, recent]);
    if (read.kind !== 'accounts') throw new Error('expected accounts');
    const [account] = read.accounts;
    expect(account.unanchored).toMatchObject({ owed: true, from: '2024-10-01', to: '2026-10-08', fileBalance: { amount: 600, atEnd: true } });
    // From today's $600 owed back, or from nothing owed at the start forwards: the same days,
    // from the day before its first charge (days of nothing before say nothing).
    const rows = [
      { date: '2025-11-19', balance: 0 },
      { date: '2025-11-20', balance: 100 },
      { date: '2026-01-05', balance: 800 },
      { date: '2026-03-01', balance: 600 },
      { date: '2026-10-08', balance: 600 },
    ];
    expect(worked(account, 'end', 600)).toMatchObject({ rows });
    expect(worked(account, 'start', 0)).toMatchObject({ rows });
    expect(worked(account, 'end', 600)?.kind === 'balances' && worked(account, 'end', 600)).toMatchObject({ transactions: { length: 3 } });
    expect(account.statement?.files.map((file) => file.from)).toEqual(['2024-10-01', '2025-01-01', '2026-01-01']);
    const shuffled = readFiles([recent, empty, year]);
    expect(shuffled.kind === 'accounts' && shuffled.accounts[0].statement?.files.map((file) => file.from)).toEqual(['2024-10-01', '2025-01-01', '2026-01-01']);
    expect(shuffled.kind === 'accounts' && worked(shuffled.accounts[0], 'end', 600)).toEqual(worked(account, 'end', 600));
  });

  it('refuses statements that leave out days between them', () => {
    const card = { card: true, number: '99995555', asOf: '20261008' };
    const empty = bankSgml([], '-600.00', { ...card, start: '20241001', end: '20250101', ids: 'A' });
    const recent = bankSgml([['20260105', '-700.00']], '-600.00', { ...card, start: '20260101', ids: 'C' });
    expect(() => readFiles([empty, recent])).toThrow(/leave out Jan 2, 2025 to Dec 31, 2025/);
  });

  it("doesn't take a statement's balance as its ending balance when it's dated more than a day after its transactions end", () => {
    const year = bankSgml([['20251120', '-100.00']], '-600.00', { card: true, number: '99995555', asOf: '20261008', start: '20250101', end: '20260101' });
    const read = readFiles([year]);
    if (read.kind !== 'accounts') throw new Error('expected accounts');
    const [account] = read.accounts;
    expect(account.unanchored).toMatchObject({ kind: 'cash', owed: true, from: '2025-01-01', to: '2026-01-01', fileBalance: { amount: 600, asOf: '2026-10-08', atEnd: false } });
    // Nothing owed at its start: from the day before the charge, then carried to its last day.
    expect(worked(account, 'start', 0)).toMatchObject({ rows: [{ date: '2025-11-19', balance: 0 }, { date: '2025-11-20', balance: 100 }, { date: '2026-01-01', balance: 100 }] });
    // Owing something at its start: from the day the statement starts.
    expect(worked(account, 'start', 40)).toMatchObject({ rows: [{ date: '2025-01-01', balance: 40 }, { date: '2025-11-20', balance: 140 }, { date: '2026-01-01', balance: 140 }] });
  });

  it("takes a statement's balance dated the day after its transactions end as its ending balance, that day's", () => {
    const read = readFiles([bankSgml([['20261001', '-100.00']], '600.00', { asOf: '20261008', end: '20261007' })]);
    if (read.kind !== 'accounts') throw new Error('expected accounts');
    expect(read.accounts[0].unanchored).toMatchObject({ to: '2026-10-08', fileBalance: { atEnd: true } });
    expect(readFiles([bankSgml([], '600.00', { asOf: '20261008', end: '20261006' })])).toMatchObject({ accounts: [{ unanchored: { fileBalance: { atEnd: false } } }] });
  });

  it('reads a CSV of transactions beside other files, named by the file', () => {
    const read = readFiles(['Date,Type,Symbol,Shares,Price,Amount\n2026-01-05,Buy,VTI,10,100,1000', bankSgml([['20260910', '500.00']], '700.00')], ['funds.csv', 'bank.qfx']);
    if (read.kind !== 'accounts') throw new Error('expected accounts');
    expect(read.accounts.map((account) => [account.fileName ?? account.number, account.unanchored?.kind ?? account.file.kind])).toEqual([['funds.csv', 'holdings'], ['99990001', 'cash']]);
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

describe('combineAccounts', () => {
  const year = (date: string, shares: string) => csvAccounts(`Date,Type,Fund,Shares,Price,Amount\n${date},Buy,Example Plan Fund,${shares},25,${Number(shares) * 25}`)!.map((account) => ({ ...account, fileName: `${date}.csv` }))[0];

  it('combines a CSV a year into one account, still waiting for a known balance', () => {
    const both = combineAccounts([year('2025-03-01', '10'), year('2026-03-01', '4')]);
    expect(both.unanchored?.transactions.map((txn) => txn.date)).toEqual(['2025-03-01', '2026-03-01']);
    expect(both.fileName).toBe('2025-03-01.csv');
  });

  it('takes what a holdings file says is held, with the transactions from the other', () => {
    const [holdings] = csvAccounts('Fund,Shares,Last trade price\nExample Plan Fund,14,25')!;
    const both = combineAccounts([year('2025-03-01', '10'), { ...holdings, fileName: 'holdings.csv' }, year('2026-03-01', '4')]);
    expect(both.unanchored).toBeUndefined();
    expect(both.file).toMatchObject({ kind: 'holdings', asOf: '2026-03-01', positions: [{ security: 'Example Plan Fund', shares: 14 }] });
    expect(both.file.kind === 'holdings' && both.file.transactions).toHaveLength(2);
  });

  it("won't combine one account's Quicken file with a CSV of it: their transactions can't be matched", () => {
    const read = readFiles([sgml(buy('B1', '20260803', '10', '12.5', '125.00'))]);
    if (read.kind !== 'accounts') throw new Error('expected accounts');
    expect(() => combineAccounts([read.accounts[0], year('2026-08-03', '10')])).toThrow(/in a Quicken file and a CSV/);
  });
});

