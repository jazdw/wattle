/**
 * Transfers between the household's own accounts: matched when there's only
 * one way to, suggested when there's more, decided by you otherwise; counted
 * on one date in the household's totals, and as neither money in nor out.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../server/db/schema';
import { candidatePairs, inTransit, names, type MoneyMove } from '../server/services/transfers';
import type { ImportedFile } from '../shared/schemas';
import type { HistoryResponse, TransactionsResponse, TransfersResponse } from '../shared/types';
import { client, createHousehold, createTestDeps, settle } from './helpers';

const move = (id: string, accountId: string, date: string, amount: number, currency = 'USD'): MoneyMove => ({ id, accountId, date, amount, currency });

describe('institution names in descriptions', () => {
  it('recognises an institution by the first distinctive word of its name', () => {
    expect(names('EXAMPLE MARKETING PAYMENTS', 'Example Brokerage')).toBe(true);
    expect(names('Payment to Bank of Contoso', 'Bank of Contoso')).toBe(true);
    // "Bank" names no one in particular.
    expect(names('ONLINE BANK TRANSFER', 'Bank of Contoso')).toBe(false);
    expect(names('Exampleville Hardware', 'Example Brokerage')).toBe(false);
    expect(names(null, 'Example Brokerage')).toBe(false);
  });
});

describe('transfer candidates', () => {
  it('pairs money out of one account with the same money into another, within days either way', () => {
    const moves = [
      move('out', 'chk', '2026-09-02', 500_00),
      move('in', 'sav', '2026-09-01', -500_00), // arrives a day before it leaves
      move('same-account', 'chk', '2026-09-02', -500_00),
      move('other-currency', 'aud', '2026-09-02', -500_00, 'AUD'),
      move('too-late', 'sav', '2026-09-08', -500_00),
      move('different', 'sav', '2026-09-02', -499_99),
    ];
    expect(candidatePairs(moves)).toEqual([{ outId: 'out', inId: 'in' }]);
  });

  it('takes a transfer off once while it’s in both accounts, and adds it while it’s in neither', () => {
    const dates = ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03'] as const;
    const same = (minor: number) => minor;
    // Arrived Sep 1, left Sep 2: counted twice on Sep 1.
    expect(inTransit([...dates], [{ out: move('o', 'chk', '2026-09-02', 500_00), in: move('i', 'sav', '2026-09-01', -500_00) }], same)).toEqual([0, -500_00, 0, 0]);
    // Left Aug 31, arrived Sep 2: in neither on Aug 31 and Sep 1.
    expect(inTransit([...dates], [{ out: move('o', 'chk', '2026-08-31', 500_00), in: move('i', 'sav', '2026-09-02', -500_00) }], same)).toEqual([500_00, 500_00, 0, 0]);
  });
});

/** A bank account's made-up download: its balances and the transactions they came from (dollars here). */
function bank(rows: [string, number][], transactions: { id: string; date: string; amount: number; description?: string; memo?: string }[]): ImportedFile {
  return {
    kind: 'balances',
    rows: rows.map(([date, balance]) => ({ date, balance })),
    transactions: transactions.map((txn) => ({ id: txn.id, date: txn.date, kind: txn.amount > 0 ? 'deposit' : 'withdrawal', label: txn.amount > 0 ? 'CREDIT' : 'DEBIT', ...(txn.description ? { description: txn.description } : {}), ...(txn.memo ? { memo: txn.memo } : {}), amount: Math.round(txn.amount * 100) })),
  };
}

async function household() {
  const deps = await createTestDeps();
  const home = await createHousehold(deps, 'Home', 'me@example.com');
  const api = client(deps, home.cookie);
  /** New accounts from their files, in one import. */
  const createAll = async (files: [string, ImportedFile][]) => {
    const response = await api('/api/imports', { method: 'POST', json: { accounts: files.map(([name, file]) => ({ label: name, target: { new: { name, type: 'depository', currency: 'USD' } }, file })) } });
    expect(response.status).toBe(200);
    await settle(deps);
    return (response.body.accounts as { accountId: string }[]).map((row) => row.accountId);
  };
  const create = async (name: string, file: ImportedFile) => (await createAll([[name, file]]))[0];
  const suggested = async () => ((await api('/api/transfers?status=suggested')).body as TransfersResponse).transfers;
  const linked = async () => ((await api('/api/transfers?status=linked')).body as TransfersResponse).transfers;
  const listed = async (accountId: string) => ((await api(`/api/accounts/${accountId}/transactions`)).body as TransactionsResponse).transactions;
  return { deps, home, api, create, createAll, suggested, linked, listed };
}

describe('transfers between your accounts', () => {
  it('links the only pair there is, and counts it on one date and as neither money in nor out for the household', async () => {
    const { api, create, linked, listed } = await household();
    // $500 arrives in savings on Sep 1, a day before checking shows it leaving; $2,000 of pay arrives on Aug 1.
    const checking = await create('Checking', bank([['2026-07-31', 0], ['2026-08-01', 2000], ['2026-09-02', 1500]], [{ id: 'C1', date: '2026-08-01', amount: 2000 }, { id: 'C2', date: '2026-09-02', amount: -500 }]));
    const savings = await create('Savings', bank([['2026-07-31', 0], ['2026-09-01', 500]], [{ id: 'S1', date: '2026-09-01', amount: 500 }]));

    const [transfer] = await linked();
    expect(transfer).toMatchObject({ status: 'auto', out: { accountName: 'Checking', date: '2026-09-02', amount: 500_00 }, in: { accountName: 'Savings', date: '2026-09-01', amount: -500_00 } });
    expect((await listed(checking)).find((row) => row.date === '2026-09-02')?.transfer).toMatchObject({ status: 'auto', accountId: savings, accountName: 'Savings', date: '2026-09-01' });

    // Net worth: counted once on Sep 1 (in savings, still in checking until Sep 2), not twice.
    const total = (await api('/api/history?range=ALL&group=total')).body as HistoryResponse;
    const on = (date: string) => total.series[0].values[total.dates.indexOf(date)];
    expect([on('2026-08-31'), on('2026-09-01'), on('2026-09-02')]).toEqual([2000_00, 2000_00, 2000_00]);
    const byAccount = (await api('/api/history?range=ALL&group=account')).body as HistoryResponse;
    expect(byAccount.series.find((series) => series.key === '__transit')?.values[byAccount.dates.indexOf('2026-09-01')]).toBe(-500_00);

    // The household's money in is the pay alone; each account still counts its side.
    const source = (await api('/api/history?range=ALL&group=source')).body as HistoryResponse;
    const [whole, ...accounts] = source.breakdown!;
    expect(whole).toMatchObject({ moneyIn: 2000_00, moneyOut: 0, start: 0, end: 2000_00 });
    expect(accounts.find((row) => row.label === 'Checking')).toMatchObject({ moneyIn: 2000_00, moneyOut: 500_00 });
    expect(accounts.find((row) => row.label === 'Savings')).toMatchObject({ moneyIn: 500_00 });
    const balance = source.series.find((series) => series.key === 'balance')!;
    expect(balance.values[source.dates.indexOf('2026-09-01')]).toBe(2000_00);
  });

  it('suggests each pair when there’s more than one way to pair them, and keeps what you decide', async () => {
    const { api, create, createAll, suggested, linked } = await household();
    // Arriving together: $500 out of checking, and $500 into each of two others.
    await createAll([
      ['Checking', bank([['2026-08-31', 1000], ['2026-09-02', 500]], [{ id: 'C1', date: '2026-09-02', amount: -500 }])],
      ['Savings', bank([['2026-08-31', 0], ['2026-09-01', 500]], [{ id: 'S1', date: '2026-09-01', amount: 500 }])],
      ['Brokerage cash', bank([['2026-08-31', 0], ['2026-09-03', 500]], [{ id: 'B1', date: '2026-09-03', amount: 500 }])],
    ]);

    const pairs = await suggested();
    expect(pairs.map((pair) => pair.in.accountName).sort()).toEqual(['Brokerage cash', 'Savings']);
    expect(await linked()).toEqual([]);

    // It went to savings: confirmed, and the other suggestion goes.
    const toSavings = pairs.find((pair) => pair.in.accountName === 'Savings')!;
    expect((await api(`/api/transfers/${toSavings.id}`, { method: 'PATCH', json: { status: 'confirmed' } })).status).toBe(200);
    expect(await suggested()).toEqual([]);
    expect(await linked()).toMatchObject([{ id: toSavings.id, status: 'confirmed' }]);

    // Unlinked (rejected), it isn't suggested or linked again: the next match finds the brokerage the only way left.
    expect((await api(`/api/transfers/${toSavings.id}`, { method: 'PATCH', json: { status: 'rejected' } })).status).toBe(200);
    expect(await linked()).toEqual([]);
    await create('Card', bank([['2026-08-31', 0], ['2026-10-01', 20]], [{ id: 'K1', date: '2026-10-01', amount: 20 }]));
    expect((await linked()).map((pair) => [pair.status, pair.in.accountName])).toEqual([['auto', 'Brokerage cash']]);
    expect(await suggested()).toEqual([]);
  });

  it('links two you choose, but only money out and the same money in, each in one link at most', async () => {
    const { deps, api, create, linked, listed } = await household();
    const checking = await create('Checking', bank([['2026-08-31', 1000], ['2026-09-02', 500]], [{ id: 'C1', date: '2026-09-02', amount: -500 }]));
    // Too far apart to be matched, near enough to link by hand.
    const savings = await create('Savings', bank([['2026-08-31', 0], ['2026-09-09', 500], ['2026-09-10', 999]], [{ id: 'S1', date: '2026-09-09', amount: 500 }, { id: 'S2', date: '2026-09-10', amount: 499 }]));
    expect(await linked()).toEqual([]);
    const out = (await listed(checking))[0];
    const [odd, arrival] = await listed(savings);

    const candidates = (await api(`/api/transactions/${out.id}/candidates`)).body.candidates as { transactionId: string }[];
    expect(candidates.map((row) => row.transactionId)).toEqual([arrival.id]);
    expect((await api('/api/transfers', { method: 'POST', json: { outId: out.id, inId: odd.id } })).status).toBe(400);
    expect((await api('/api/transfers', { method: 'POST', json: { outId: out.id, inId: arrival.id } })).status).toBe(200);
    expect(await linked()).toMatchObject([{ status: 'confirmed', out: { transactionId: out.id }, in: { transactionId: arrival.id } }]);
    expect((await api('/api/transfers', { method: 'POST', json: { outId: out.id, inId: arrival.id } })).status).toBe(409);

    // Another household can't see or link them.
    const other = client(deps, (await createHousehold(deps, 'Other', 'other@example.com')).cookie);
    expect(((await other('/api/transfers?status=linked')).body as TransfersResponse).transfers).toEqual([]);
    expect((await other('/api/transfers', { method: 'POST', json: { outId: out.id, inId: arrival.id } })).status).toBe(400);
    const [row] = await deps.db.select().from(schema.transfers).where(eq(schema.transfers.outId, out.id));
    expect((await other(`/api/transfers/${row.id}`, { method: 'PATCH', json: { status: 'rejected' } })).status).toBe(404);
  });

  it('refuses a second link for a transaction in the database itself', async () => {
    const { deps, create, linked } = await household();
    await create('Checking', bank([['2026-08-31', 1000], ['2026-09-02', 500]], [{ id: 'C1', date: '2026-09-02', amount: -500 }]));
    await create('Savings', bank([['2026-08-31', 0], ['2026-09-01', 500]], [{ id: 'S1', date: '2026-09-01', amount: 500 }]));
    const [transfer] = await linked();
    const [row] = await deps.db.select().from(schema.transfers).where(eq(schema.transfers.id, transfer.id));
    await expect(deps.db.insert(schema.transfers).values({ ...row, id: 'second', inId: row.outId })).rejects.toThrow();
  });

  it('links a pair whose descriptions quote the same reference number, even beside another candidate', async () => {
    const { createAll, suggested, linked } = await household();
    // $500 out of checking; savings gets two $500 that day, one from checking (the bank quotes its reference on both sides), one from elsewhere.
    await createAll([
      ['Checking', bank([['2026-08-31', 1000], ['2026-09-02', 500]], [{ id: 'C1', date: '2026-09-02', amount: -500, description: 'Transfer to savings transaction#: 12345678901' }])],
      ['Savings', bank([['2026-08-31', 0], ['2026-09-02', 1000]], [{ id: 'S1', date: '2026-09-02', amount: 500, description: 'Example Bank deposit' }, { id: 'S2', date: '2026-09-02', amount: 500, description: 'Transfer from checking transaction#: 12345678901' }])],
    ]);
    expect((await linked()).map((pair) => [pair.status, pair.in.description])).toEqual([['auto', 'Transfer from checking transaction#: 12345678901']]);
    expect(await suggested()).toEqual([]);
  });

  it('pairs identical transfers that can’t be told apart, as any pairing is the same', async () => {
    const { createAll, suggested, linked } = await household();
    await createAll([
      ['Checking', bank([['2026-08-31', 1000], ['2026-09-02', 0]], [{ id: 'C1', date: '2026-09-02', amount: -500 }, { id: 'C2', date: '2026-09-02', amount: -500 }])],
      ['Savings', bank([['2026-08-31', 0], ['2026-09-03', 1000]], [{ id: 'S1', date: '2026-09-03', amount: 500 }, { id: 'S2', date: '2026-09-03', amount: 500 }])],
    ]);
    expect((await linked()).map((pair) => pair.status)).toEqual(['auto', 'auto']);
    expect(await suggested()).toEqual([]);
  });

  it("lists an account's transactions and their transfers when there are more than a query can bind at once", async () => {
    const { create, listed } = await household();
    const transactions = Array.from({ length: 120 }, (_, index) => ({ id: `C${index}`, date: '2026-09-02', amount: -(index + 1) }));
    const checking = await create('Checking', bank([['2026-08-31', 10000], ['2026-09-02', 10000 - 7260]], transactions));
    expect(await listed(checking)).toHaveLength(120);
  });

  it("links the one whose description names the other account's institution", async () => {
    const { deps, api, suggested, linked } = await household();
    // Two $500 out of checking on one day; the brokerage got one of them.
    const response = await api('/api/imports', {
      method: 'POST',
      json: {
        accounts: [
          { label: 'Checking', target: { new: { name: 'Checking', type: 'depository', currency: 'USD', institutionName: 'Northwind Bank' } }, file: bank([['2026-08-31', 1000], ['2026-09-02', 0]], [{ id: 'C1', date: '2026-09-02', amount: -500, description: 'CONTOSO BANK TRANSFER · PPD ID: 1111111111' }, { id: 'C2', date: '2026-09-02', amount: -500, description: 'EXAMPLE BROKERAGE PAYMENTS · PPD ID: 2222222222' }]) },
          { label: 'Brokerage', target: { new: { name: 'Brokerage cash', type: 'depository', currency: 'USD', institutionName: 'Example Brokerage' } }, file: bank([['2026-08-31', 0], ['2026-09-02', 500]], [{ id: 'B1', date: '2026-09-02', amount: 500 }]) },
        ],
      },
    });
    expect(response.status).toBe(200);
    await settle(deps);
    expect((await linked()).map((pair) => pair.out.description)).toEqual(['EXAMPLE BROKERAGE PAYMENTS · PPD ID: 2222222222']);
    expect(await suggested()).toEqual([]);
  });

  it('links one of several candidates that can’t be told apart, as any would be the same', async () => {
    const { createAll, suggested, linked } = await household();
    // One $500 out; two $500 into savings the next day, alike in every way (the other from elsewhere).
    await createAll([
      ['Checking', bank([['2026-08-31', 1000], ['2026-09-02', 500]], [{ id: 'C1', date: '2026-09-02', amount: -500 }])],
      ['Savings', bank([['2026-08-31', 0], ['2026-09-03', 1000]], [{ id: 'S1', date: '2026-09-03', amount: 500 }, { id: 'S2', date: '2026-09-03', amount: 500 }])],
    ]);
    expect((await linked()).map((pair) => pair.status)).toEqual(['auto']);
    expect(await suggested()).toEqual([]);
  });

  it('still asks when the candidates differ', async () => {
    const { createAll, suggested, linked } = await household();
    await createAll([
      ['Checking', bank([['2026-08-31', 1000], ['2026-09-02', 500]], [{ id: 'C1', date: '2026-09-02', amount: -500 }])],
      ['Savings', bank([['2026-08-31', 0], ['2026-09-03', 1000]], [{ id: 'S1', date: '2026-09-03', amount: 500, description: 'From checking' }, { id: 'S2', date: '2026-09-03', amount: 500, description: 'From another bank' }])],
    ]);
    expect(await linked()).toEqual([]);
    expect(await suggested()).toHaveLength(2);
  });

  it("moves a transfer you confirmed to the file's transaction when an import brings one that is the institution's", async () => {
    const { deps, home, api, create, linked, listed } = await household();
    const checking = await create('Checking', bank([['2026-09-01', 1000], ['2026-09-10', 1000]], []));
    const savings = await create('Savings', bank([['2026-09-01', 0], ['2026-09-10', 0]], []));
    // The bank report's sides, after both files' days, linked by you.
    const report = (id: string, accountId: string, amount: number, description: string) => ({ id, householdId: home.householdId, accountId, source: 'report' as const, externalId: id, date: '2026-09-12', amount, currency: 'USD', description, createdAt: 0 });
    await deps.db.insert(schema.transactions).values([report('r-out', checking, 500_00, 'Online transfer to savings ref 1234567890'), report('r-in', savings, -500_00, 'Online transfer from checking')]);
    await deps.db.insert(schema.transfers).values({ id: 't-1', householdId: home.householdId, outId: 'r-out', inId: 'r-in', status: 'confirmed', createdAt: 0, decidedAt: 0 });

    // Checking's newer file has the transfer a day earlier, its text split across NAME (padded) and MEMO.
    const response = await api('/api/imports', {
      method: 'POST',
      json: { accounts: [{ label: 'Checking', target: { accountId: checking }, file: bank([['2026-09-01', 1000], ['2026-09-11', 500], ['2026-09-12', 500]], [{ id: 'C1', date: '2026-09-11', amount: -500, description: 'Online transfer to     savings', memo: 'ref 1234567890' }]) }] },
    });
    expect(response.status).toBe(200);
    await settle(deps);
    const rows = await listed(checking);
    expect(rows.map((row) => [row.source, row.date, row.description])).toEqual([['import', '2026-09-11', 'Online transfer to savings ref 1234567890']]);
    const [transfer] = await linked();
    expect(transfer).toMatchObject({ id: 't-1', status: 'confirmed', out: { transactionId: rows[0].id, date: '2026-09-11' }, in: { accountId: savings, date: '2026-09-12' } });
  });
});

