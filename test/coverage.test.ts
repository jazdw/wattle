/**
 * Each account's stored history, summed up for the history timeline: runs of
 * balances by source with gaps, the days each source's transactions cover
 * (recorded where they're written), and a balance from the institution that
 * has stopped updating.
 */
import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { runAtomic } from '../server/db/batch';
import * as schema from '../server/db/schema';
import { Tenant } from '../server/db/tenant';
import { balanceRuns, coverageRanges, rangeStatements, unchangedSince } from '../server/services/coverage';
import type { ImportedBalances } from '../shared/schemas';
import type { CoverageResponse } from '../shared/types';
import { transactionRuns } from '../src/lib/coverage';
import { account, fakePlaid, security, holding } from './fakes';
import { client, createHousehold, createTestDeps, settle } from './helpers';

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
    // A file without the days it covers: its first transaction's to its last.
    expect(mine.transactions).toEqual([{ from: '2026-09-30', to: '2026-09-30', source: 'files', count: 1 }]);
    expect(mine.unchangedSince).toBeNull();

    const other = client(deps, (await createHousehold(deps, 'Other', 'other@example.com')).cookie);
    expect(((await other('/api/coverage')).body as CoverageResponse).accounts).toEqual([]);
  });
});

async function household() {
  const deps = await createTestDeps();
  const home = await createHousehold(deps, 'Home', 'me@example.com');
  const api = client(deps, home.cookie);
  const id = (await api('/api/accounts', { method: 'POST', json: { name: 'Checking', type: 'depository', currency: 'USD' } })).body.id as string;
  const tenant = new Tenant(deps.db, home.householdId);
  const ranges = async (accountId = id) =>
    (await deps.db.select().from(schema.transactionRanges).where(eq(schema.transactionRanges.accountId, accountId)).orderBy(asc(schema.transactionRanges.source), asc(schema.transactionRanges.from))).map(({ source, from, to }) => ({ source, from, to }));
  return { deps, api, id, tenant, ranges };
}

describe('recording the days transactions cover', () => {
  it('merges a range with those of its source it overlaps or touches, keeps separate ones and other sources apart, and adds nothing already covered', async () => {
    const { deps, id, tenant, ranges } = await household();
    const record = async (source: 'import' | 'report' | 'plaid', from: string, to: string) => {
      const statements = await rangeStatements(tenant, id, source, from, to, deps.now().getTime());
      if (statements.length > 0) await runAtomic(deps.db, statements);
      return statements.length;
    };
    await record('import', '2026-01-01', '2026-01-31');
    await record('import', '2026-03-01', '2026-03-31');
    await record('report', '2026-01-15', '2026-02-15');
    expect(await ranges()).toEqual([
      { source: 'import', from: '2026-01-01', to: '2026-01-31' },
      { source: 'import', from: '2026-03-01', to: '2026-03-31' },
      { source: 'report', from: '2026-01-15', to: '2026-02-15' },
    ]);
    // Already covered: nothing written.
    expect(await record('import', '2026-01-10', '2026-01-20')).toBe(0);
    // Overlapping one and touching the other: all three become one.
    await record('import', '2026-01-20', '2026-02-28');
    expect(await ranges()).toEqual([
      { source: 'import', from: '2026-01-01', to: '2026-03-31' },
      { source: 'report', from: '2026-01-15', to: '2026-02-15' },
    ]);
    // Touching at the start, and a day apart (separate).
    await record('report', '2026-01-10', '2026-01-14');
    await record('report', '2026-02-17', '2026-02-20');
    expect(await ranges()).toEqual([
      { source: 'import', from: '2026-01-01', to: '2026-03-31' },
      { source: 'report', from: '2026-01-10', to: '2026-02-15' },
      { source: 'report', from: '2026-02-17', to: '2026-02-20' },
    ]);
  });

  it("a statement's days are stored, the same file again adds nothing, and two files merge", async () => {
    const { api, id, ranges } = await household();
    const statement = (covers: { from: string; to: string }, rows: ImportedBalances['rows'], transactions: NonNullable<ImportedBalances['transactions']>) =>
      api('/api/imports', { method: 'POST', json: { accounts: [{ label: '··1234', target: { accountId: id }, file: { kind: 'balances', rows, transactions, covers } }] } });
    const september = () => statement({ from: '2026-09-01', to: '2026-09-30' }, [{ date: '2026-09-09', balance: 0 }, { date: '2026-09-10', balance: 100 }, { date: '2026-09-30', balance: 100 }], [{ id: 'T1', date: '2026-09-10', kind: 'deposit', label: 'In', amount: 100_00 }]);
    expect((await september()).status).toBe(200);
    // Its days, though its balances start the day before its first transaction.
    expect(await ranges()).toEqual([{ source: 'import', from: '2026-09-01', to: '2026-09-30' }]);
    expect((await september()).status).toBe(200);
    expect(await ranges()).toEqual([{ source: 'import', from: '2026-09-01', to: '2026-09-30' }]);
    // The next month's: one range. Days past its last balance aren't claimed.
    await statement({ from: '2026-10-01', to: '2026-10-31' }, [{ date: '2026-10-05', balance: 50 }], [{ id: 'T2', date: '2026-10-05', kind: 'withdrawal', label: 'Out', amount: -50_00 }]);
    expect(await ranges()).toEqual([{ source: 'import', from: '2026-09-01', to: '2026-10-05' }]);

    const body = (await api('/api/coverage')).body as CoverageResponse;
    expect(body.accounts.find((row) => row.accountId === id)!.transactions).toEqual([{ from: '2026-09-01', to: '2026-10-05', source: 'files', count: 2 }]);
  });

  it('a CSV (no days stated) records its first transaction to its last; a file of balances alone, none', async () => {
    const { api, id, ranges } = await household();
    const send = (file: ImportedBalances) => api('/api/imports', { method: 'POST', json: { accounts: [{ label: 'File', target: { accountId: id }, file }] } });
    await send({ kind: 'balances', rows: [{ date: '2026-06-01', balance: 10 }, { date: '2026-06-30', balance: 10 }] });
    expect(await ranges()).toEqual([]);
    await send({
      kind: 'balances',
      rows: [{ date: '2026-07-01', balance: 10 }, { date: '2026-07-31', balance: 30 }],
      transactions: [
        { date: '2026-07-03', kind: 'deposit', label: 'In', amount: 10_00 },
        { date: '2026-07-20', kind: 'deposit', label: 'In', amount: 10_00 },
      ],
    });
    expect(await ranges()).toEqual([{ source: 'import', from: '2026-07-03', to: '2026-07-20' }]);
  });

  it("a bank report records the report's day less the days it has; a complete investment fetch, its earliest transaction to today for every investment account; hiding removes Plaid's", async () => {
    const plaid = fakePlaid({
      accounts: [account('brk', 'investment', 1000), account('ira', 'investment', 0), account('chk', 'depository', 500), account('sav', 'depository', 900)],
      securities: [security('s-vti', 'VTI', 'etf', 100)],
      holdings: [holding('brk', 's-vti', 10, 100)],
      transactions: [
        { investment_transaction_id: 't1', account_id: 'brk', security_id: 's-vti', date: '2026-09-01', name: 'Buy VTI', type: 'buy', subtype: 'buy', quantity: 1, amount: 100, price: 100, fees: 0, iso_currency_code: 'USD' },
      ],
      historicalBalances: { chk: [{ date: '2026-10-01', current: 500 }], sav: [{ date: '2026-10-01', current: 900 }] },
      reportTransactions: {
        chk: [{ transaction_id: 'bt-1', date: '2026-10-02', amount: -1.5, original_description: 'Interest', pending: false }],
        sav: [
          { transaction_id: 'bt-2', date: '2026-09-15', amount: -2, original_description: 'Interest', pending: false },
          { transaction_id: 'bt-3', date: '2026-10-01', amount: -2, original_description: 'Interest', pending: false },
        ],
      },
      // Made at 10pm on Oct 8 in New York; the savings account's days aren't given.
      reportGenerated: '2026-10-09T02:00:00Z',
      reportDaysAvailable: { chk: 60 },
      itemProducts: ['assets', 'investments'],
    });
    const deps = await createTestDeps({ plaid });
    const home = await createHousehold(deps, 'Home', 'me@example.com');
    const api = client(deps, home.cookie);
    await api('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'account' } });
    await settle(deps, 20);
    const accounts = (await api('/api/accounts')).body.accounts as { id: string; name: string }[];
    const id = (name: string) => accounts.find((row) => row.name === name)!.id;
    const rangesOf = async (name: string) => (await deps.db.select().from(schema.transactionRanges).where(eq(schema.transactionRanges.accountId, id(name)))).map(({ source, from, to }) => ({ source, from, to }));

    expect(await rangesOf('chk')).toEqual([{ source: 'report', from: '2026-08-09', to: '2026-10-08' }]);
    // Without the days it has: its first transaction's to its last.
    expect(await rangesOf('sav')).toEqual([{ source: 'report', from: '2026-09-15', to: '2026-10-01' }]);
    expect(await rangesOf('brk')).toEqual([{ source: 'plaid', from: '2026-09-01', to: '2026-10-08' }]);
    // An investment account Plaid returned none for has none on those days; a bank account isn't one it reports.
    expect(await rangesOf('ira')).toEqual([{ source: 'plaid', from: '2026-09-01', to: '2026-10-08' }]);

    // Hiding the account (its data deleted) removes Plaid's days with its transactions.
    expect((await api(`/api/accounts/${id('brk')}`, { method: 'PATCH', json: { isHidden: true, purge: true } })).status).toBe(200);
    expect(await rangesOf('brk')).toEqual([]);
  });

  it("an investment fetch Plaid hasn't finished records nothing", async () => {
    const plaid = fakePlaid({
      accounts: [account('brk', 'investment', 1000)],
      securities: [security('s-vti', 'VTI', 'etf', 100)],
      holdings: [holding('brk', 's-vti', 10, 100)],
      transactionsNotReady: true,
    });
    const deps = await createTestDeps({ plaid });
    const home = await createHousehold(deps, 'Home', 'me@example.com');
    await client(deps, home.cookie)('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'investments' } });
    await settle(deps, 20);
    expect(await deps.db.select().from(schema.transactionRanges)).toEqual([]);
  });
});

describe('transaction ranges for the timeline', () => {
  it('merges each source, counts days no range covers, and splits where another source starts or ends', () => {
    expect(
      coverageRanges(
        [
          { source: 'files', from: '2026-01-01', to: '2026-01-31' },
          { source: 'files', from: '2026-01-20', to: '2026-02-10' },
          { source: 'bank', from: '2026-02-01', to: '2026-03-31' },
        ],
        [
          { date: '2026-01-05', source: 'files', count: 2 },
          { date: '2026-02-05', source: 'files', count: 1 },
          { date: '2026-03-01', source: 'bank', count: 4 },
          // Stored before ranges were: covered by itself.
          { date: '2026-05-01', source: 'bank', count: 1 },
        ],
      ),
    ).toEqual([
      { from: '2026-01-01', to: '2026-01-31', source: 'files', count: 2 },
      { from: '2026-02-01', to: '2026-02-10', source: 'bank', count: 0 },
      { from: '2026-02-01', to: '2026-02-10', source: 'files', count: 1 },
      { from: '2026-02-11', to: '2026-03-31', source: 'bank', count: 4 },
      { from: '2026-05-01', to: '2026-05-01', source: 'bank', count: 1 },
    ]);
  });

  it('draws each day as the source that counts there: a file being imported, then your files, then the institution', () => {
    const ranges = [
      { from: '2026-01-01', to: '2026-01-31', source: 'bank' as const, count: 3 },
      { from: '2026-02-01', to: '2026-02-28', source: 'bank' as const, count: 0 },
      { from: '2026-02-01', to: '2026-02-28', source: 'files' as const, count: 5 },
      { from: '2026-03-01', to: '2026-03-31', source: 'bank' as const, count: 2 },
      { from: '2026-05-01', to: '2026-05-31', source: 'bank' as const, count: 1 },
    ];
    expect(transactionRuns(ranges)).toEqual([
      { from: '2026-01-01', to: '2026-01-31', source: 'bank', count: 3 },
      { from: '2026-02-01', to: '2026-02-28', source: 'files', count: 5 },
      { from: '2026-03-01', to: '2026-03-31', source: 'bank', count: 2 },
      // April is a gap.
      { from: '2026-05-01', to: '2026-05-31', source: 'bank', count: 1 },
    ]);
    // A file being imported over part of what's stored: the institution's cut there, its count no longer known.
    expect(transactionRuns([...ranges, { from: '2026-01-15', to: '2026-02-10', source: 'new', count: 9 }])).toEqual([
      { from: '2026-01-01', to: '2026-01-14', source: 'bank', count: null },
      { from: '2026-01-15', to: '2026-02-10', source: 'new', count: 9 },
      { from: '2026-02-11', to: '2026-02-28', source: 'files', count: null },
      { from: '2026-03-01', to: '2026-03-31', source: 'bank', count: 2 },
      { from: '2026-05-01', to: '2026-05-31', source: 'bank', count: 1 },
    ]);
  });
});
