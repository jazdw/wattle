import { describe, expect, it } from 'vitest';
import type { AccountCoverage } from '../../shared/types';
import { transactionRuns, withImport } from './coverage';

// Made up: an account with the institution's balances and a bank report's transactions.
const stored: AccountCoverage = {
  accountId: 'a',
  balances: [
    { from: '2026-01-01', to: '2026-03-31', source: 'bank', filled: false },
    { from: '2026-04-01', to: '2026-06-30', source: 'bank', filled: true },
  ],
  transactions: [{ from: '2026-01-01', to: '2026-06-30', source: 'bank', count: 40 }],
  unchangedSince: null,
};

describe('withImport', () => {
  it("lays a statement's days over what's stored: its balances replace the stored ones, its transactions count on the days it covers", () => {
    const file = {
      kind: 'balances' as const,
      rows: [{ date: '2026-02-01' as const }, { date: '2026-02-28' as const }],
      transactions: [{ date: '2026-02-03' as const }, { date: '2026-02-20' as const }],
      covers: { from: '2026-02-01' as const, to: '2026-02-28' as const },
    };
    const shown = withImport(stored, file, '2026-07-01');
    expect(shown.balances).toEqual([
      { from: '2026-01-01', to: '2026-01-31', source: 'bank', filled: false },
      { from: '2026-02-01', to: '2026-02-28', source: 'new', filled: false },
      { from: '2026-03-01', to: '2026-03-31', source: 'bank', filled: false },
      { from: '2026-04-01', to: '2026-06-30', source: 'bank', filled: true },
    ]);
    expect(transactionRuns(shown.transactions).map(({ from, to, source, count }) => ({ from, to, source, count }))).toEqual([
      { from: '2026-01-01', to: '2026-01-31', source: 'bank', count: null },
      { from: '2026-02-01', to: '2026-02-28', source: 'new', count: 2 },
      { from: '2026-03-01', to: '2026-06-30', source: 'bank', count: null },
    ]);
  });

  it("takes an investment download's balances from its first transaction to the day its positions are as of, and a CSV's transactions from its first to its last", () => {
    const file = { kind: 'holdings' as const, asOf: '2026-09-30' as const, transactions: [{ date: '2026-08-15' as const }, { date: '2026-07-10' as const }] };
    const shown = withImport(undefined, file, '2026-09-20');
    expect(shown.balances).toEqual([{ from: '2026-07-10', to: '2026-09-20', source: 'new', filled: false }]);
    expect(shown.transactions).toEqual([{ from: '2026-07-10', to: '2026-08-15', source: 'new', count: 2 }]);
  });

  it("drops a balance that stopped updating where the file's days reach it", () => {
    const stale = { ...stored, unchangedSince: '2026-05-01' as const };
    const before = { kind: 'balances' as const, rows: [{ date: '2026-02-01' as const }, { date: '2026-02-28' as const }] };
    const after = { kind: 'balances' as const, rows: [{ date: '2026-04-01' as const }, { date: '2026-06-30' as const }] };
    expect(withImport(stale, before, '2026-07-01').unchangedSince).toBe('2026-05-01');
    expect(withImport(stale, after, '2026-07-01').unchangedSince).toBeNull();
  });
});
