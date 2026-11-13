/**
 * Each account's stored history, summed up for the history timeline: runs of
 * balances by source with gaps, transactions per day, and a balance from the
 * institution that has stopped updating.
 */
import { describe, expect, it } from 'vitest';
import { balanceRuns, unchangedSince } from '../server/services/coverage';
import type { CoverageResponse } from '../shared/types';
import { client, createHousehold, createTestDeps } from './helpers';

const day = (date: string, source: string, balance = 100, extra: { unmatched?: boolean; priceSource?: string | null } = {}) => ({ accountId: 'a', date, balance, source, unmatched: false, priceSource: null, ...extra });

describe('balance runs', () => {
  it('runs of days from one source, a new one where the source changes or a day is missing; carried days filled, with the run before', () => {
    expect(
      balanceRuns([
        day('2026-01-01', 'import'),
        day('2026-01-02', 'import'),
        day('2026-01-03', 'snapshot'),
        day('2026-01-04', 'carried'),
        day('2026-01-05', 'snapshot'),
        // Missing the 6th and 7th: a gap.
        day('2026-01-08', 'snapshot'),
        day('2026-01-09', 'manual'),
        day('2026-01-10', 'rebuilt', 100, { unmatched: true }),
      ]),
    ).toEqual([
      { from: '2026-01-01', to: '2026-01-02', source: 'files', filled: false },
      { from: '2026-01-03', to: '2026-01-03', source: 'bank', filled: false },
      { from: '2026-01-04', to: '2026-01-04', source: 'bank', filled: true },
      { from: '2026-01-05', to: '2026-01-05', source: 'bank', filled: false },
      { from: '2026-01-08', to: '2026-01-08', source: 'bank', filled: false },
      { from: '2026-01-09', to: '2026-01-09', source: 'you', filled: false },
      { from: '2026-01-10', to: '2026-01-10', source: 'bank', filled: true },
    ]);
  });
});

describe('a balance that has stopped updating', () => {
  const days = (count: number, last = 100) => [day('2026-01-01', 'import', 50), ...Array.from({ length: count }, (_, index) => day(`2026-01-${String(index + 2).padStart(2, '0')}`, 'snapshot', last))];
  it('is the institution’s balance unchanged a week or more with transactions dated after', () => {
    expect(unchangedSince(days(10), '2026-01-08')).toBe('2026-01-02');
  });
  it('isn’t with nothing happening (an account that sits still), under a week, or a balance from a file', () => {
    expect(unchangedSince(days(10), '2026-01-01')).toBeNull();
    expect(unchangedSince(days(10), undefined)).toBeNull();
    expect(unchangedSince(days(5), '2026-01-05')).toBeNull();
    expect(unchangedSince([...days(10), day('2026-01-12', 'import', 100)], '2026-01-12')).toBeNull();
  });
});

describe('GET /api/coverage', () => {
  it("gives each of the household's accounts, and no other household's", async () => {
    const deps = await createTestDeps();
    const home = await createHousehold(deps, 'Home', 'me@example.com');
    const api = client(deps, home.cookie);
    const id = (await api('/api/accounts', { method: 'POST', json: { name: 'Savings', type: 'depository', currency: 'USD', balance: 100, date: '2026-10-01' } })).body.id as string;
    await api('/api/imports', {
      method: 'POST',
      json: { accounts: [{ label: 'File', target: { accountId: id }, file: { kind: 'balances', rows: [{ date: '2026-09-28', balance: 50 }, { date: '2026-09-30', balance: 100 }], transactions: [{ id: 'T1', date: '2026-09-30', kind: 'deposit', label: 'In', amount: 50_00 }] } }] },
    });
    const body = (await api('/api/coverage')).body as CoverageResponse;
    const mine = body.accounts.find((account) => account.accountId === id)!;
    expect(mine.balances).toEqual([
      { from: '2026-09-28', to: '2026-09-30', source: 'files', filled: false },
      { from: '2026-10-01', to: '2026-10-01', source: 'you', filled: false },
    ]);
    expect(mine.transactions).toEqual([{ date: '2026-09-30', source: 'files', count: 1 }]);
    expect(mine.unchangedSince).toBeNull();

    const other = client(deps, (await createHousehold(deps, 'Other', 'other@example.com')).cookie);
    expect(((await other('/api/coverage')).body as CoverageResponse).accounts).toEqual([]);
  });
});
