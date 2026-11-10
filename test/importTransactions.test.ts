/**
 * An import keeps its file's transactions as the account's: found again by
 * a re-import (a kind you set stays), and in a linked account counted
 * instead of the institution's on the file's days.
 */
import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../server/db/schema';
import type { ImportedFile } from '../shared/schemas';
import { account, closes, fakePlaid, fakePrices, holding, security } from './fakes';
import { client, createHousehold, createTestDeps, settle, TODAY } from './helpers';

type Row = { id?: string; date: string; kind: 'buy' | 'sell' | 'income' | 'deposit' | 'withdrawal'; shares?: number; amount: number; description?: string };

/** A made-up download of VTI and cash: amounts in dollars here, sent in cents. */
function download(shares: number, cash: number, rows: Row[]): ImportedFile {
  return {
    kind: 'holdings',
    asOf: TODAY,
    securities: [{ id: 'VTI', ticker: 'VTI', name: 'VTI' }],
    positions: [{ security: 'VTI', shares }],
    cash: cash * 100,
    transactions: rows.map((row) => {
      const amount = Math.round(row.amount * 100);
      const trade = row.kind === 'buy' || row.kind === 'sell';
      return { ...row, label: row.kind.toUpperCase(), security: trade || row.kind === 'income' ? 'VTI' : null, shares: row.shares ?? 0, price: trade ? 100 : 0, amount, value: trade ? Math.abs(amount) : 0, charges: 0 };
    }),
  };
}

/** Buy 25 VTI the day before the $2,500 paying for it arrives, a $50 dividend, sell 5, withdraw the $500. */
const HISTORY: Row[] = [
  { id: 'F1', date: '2026-05-29', kind: 'buy', shares: 25, amount: -2500 },
  { id: 'F2', date: '2026-06-01', kind: 'deposit', amount: 2500, description: 'From checking' },
  { id: 'F3', date: '2026-07-15', kind: 'income', amount: 50 },
  { id: 'F4', date: '2026-09-01', kind: 'sell', shares: -5, amount: 500 },
  { id: 'F5', date: '2026-09-02', kind: 'withdrawal', amount: -500 },
];

async function household() {
  const deps = await createTestDeps({ prices: fakePrices({ VTI: closes('2025-09-01', 450, 100) }) });
  const home = await createHousehold(deps, 'Home', 'me@example.com');
  const api = client(deps, home.cookie);
  const importing = (target: { accountId: string } | { new: { name: string; type: string; currency: string } }, file: ImportedFile) =>
    api('/api/imports', { method: 'POST', json: { accounts: [{ label: 'The file', target, file }] } });
  const stored = async (accountId: string) =>
    (await deps.db.select().from(schema.transactions).where(eq(schema.transactions.accountId, accountId)).orderBy(asc(schema.transactions.date), asc(schema.transactions.externalId))).map((row) => ({
      source: row.source,
      externalId: row.externalId,
      date: row.date,
      amount: row.amount,
      type: row.type,
      subtype: row.subtype,
    }));
  const listed = async (accountId: string) => (await api(`/api/accounts/${accountId}/transactions`)).body.transactions as { id: string; date: string; kind: string; kindByYou: boolean; description: string | null }[];
  return { deps, api, importing, stored, listed };
}

describe('imported transactions', () => {
  it("keeps a file's transactions as the account's, by the file's ids, with the kinds it read", async () => {
    const { deps, importing, stored, listed } = await household();
    const response = await importing({ new: { name: 'Brokerage', type: 'investment', currency: 'USD' } }, download(20, 50, HISTORY));
    expect(response.status).toBe(200);
    const accountId = response.body.accounts[0].accountId as string;
    await settle(deps);

    // Amounts kept positive when money leaves, as the institution's are; the file's kind in the subtype.
    expect(await stored(accountId)).toEqual([
      { source: 'import', externalId: 'F1', date: '2026-05-29', amount: 2500_00, type: 'BUY', subtype: 'buy' },
      { source: 'import', externalId: 'F2', date: '2026-06-01', amount: -2500_00, type: 'DEPOSIT', subtype: 'deposit' },
      { source: 'import', externalId: 'F3', date: '2026-07-15', amount: -50_00, type: 'INCOME', subtype: 'income' },
      { source: 'import', externalId: 'F4', date: '2026-09-01', amount: -500_00, type: 'SELL', subtype: 'sell' },
      { source: 'import', externalId: 'F5', date: '2026-09-02', amount: 500_00, type: 'WITHDRAWAL', subtype: 'withdrawal' },
    ]);
    expect((await listed(accountId)).map((row) => [row.date, row.kind, row.description])).toEqual([
      ['2026-09-02', 'withdrawal', null],
      ['2026-09-01', 'sell', null],
      ['2026-07-15', 'income', null],
      ['2026-06-01', 'deposit', 'From checking'],
      ['2026-05-29', 'buy', null],
    ]);
  });

  it('a re-import finds the same rows again: a kind you set stays, and a row the file no longer has goes', async () => {
    const { deps, api, importing, stored, listed } = await household();
    // A file without ids (a CSV): its rows are known by their details.
    const noIds = HISTORY.map((row) => ({ ...row, id: undefined }));
    const accountId = (await importing({ new: { name: 'Brokerage', type: 'investment', currency: 'USD' } }, download(20, 50, noIds))).body.accounts[0].accountId as string;
    await settle(deps);
    const deposit = (await listed(accountId)).find((row) => row.date === '2026-06-01')!;
    expect((await api(`/api/transactions/${deposit.id}`, { method: 'PATCH', json: { kind: 'income' } })).status).toBe(200);

    // The dividend is gone from the new file (and the cash with it).
    const again = await importing({ accountId }, download(20, 0, noIds.filter((row) => row.kind !== 'income')));
    expect(again.status).toBe(200);
    await settle(deps);
    const rows = await listed(accountId);
    expect(rows.map((row) => row.date)).toEqual(['2026-09-02', '2026-09-01', '2026-06-01', '2026-05-29']);
    expect(rows.find((row) => row.date === '2026-06-01')).toMatchObject({ id: deposit.id, kind: 'income', kindByYou: true });
    expect((await stored(accountId)).map((row) => row.externalId)[0]).toBe('row:2026-05-29:BUY:-250000:VTI:25:0');
  });

  it("keeps a bank file's transactions, a card's purchases as money out and its payments in", async () => {
    const { deps, importing, stored } = await household();
    const file: ImportedFile = {
      kind: 'balances',
      rows: [
        { date: '2026-09-15', balance: 350 },
        { date: '2026-09-25', balance: 300 },
      ],
      transactions: [
        { id: 'T0', date: '2026-09-15', kind: 'withdrawal', label: 'DEBIT', description: 'Example store', amount: -100_00 },
        { id: 'T1', date: '2026-09-25', kind: 'deposit', label: 'CREDIT', description: 'Payment', amount: 50_00 },
      ],
    };
    const response = await importing({ new: { name: 'Card', type: 'credit', currency: 'USD' } }, file);
    expect(response.status).toBe(200);
    await settle(deps);
    expect(await stored(response.body.accounts[0].accountId)).toEqual([
      { source: 'import', externalId: 'T0', date: '2026-09-15', amount: 100_00, type: 'DEBIT', subtype: 'withdrawal' },
      { source: 'import', externalId: 'T1', date: '2026-09-25', amount: -50_00, type: 'CREDIT', subtype: 'deposit' },
    ]);
  });

  it("in a linked account, counts the file's transactions on its days and the institution's after, each of theirs that's one of the file's paired", async () => {
    const plaidRow = (id: string, date: string, subtype: string, security: string | null, amount: number, name = subtype) => ({ investment_transaction_id: id, account_id: 'brk', security_id: security, date, name, type: 'cash', subtype, quantity: 0, amount, price: 0, fees: 0, iso_currency_code: 'USD' });
    const plaid = fakePlaid({
      accounts: [account('brk', 'investment', 2050)],
      securities: [security('s-vti', 'VTI', 'etf', 100), security('s-cash', 'CUR:USD', 'cash', 1, 'US Dollar')],
      holdings: [holding('brk', 's-vti', 20, 100), holding('brk', 's-cash', 50, 1)],
      transactions: [
        // The file's Jul 15 dividend, a day late; its Sep 2 withdrawal two days late, after the file's last day, with the full description; then one of its own.
        plaidRow('p-1', '2026-07-16', 'dividend', 's-vti', -50),
        plaidRow('p-2', '2026-09-04', 'withdrawal', null, 500, 'From checking to savings'),
        plaidRow('p-3', '2026-10-01', 'dividend', 's-vti', -50),
      ],
    });
    const deps = await createTestDeps({ plaid, prices: fakePrices({ VTI: closes('2024-09-01', 800, 100) }) });
    const home = await createHousehold(deps, 'Home', 'me@example.com');
    const api = client(deps, home.cookie);
    await api('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'investments' } });
    await settle(deps);
    const [brk] = await deps.db.select().from(schema.accounts);
    const listed = async () =>
      ((await api(`/api/accounts/${brk.id}/transactions`)).body.transactions as { id: string; source: string; date: string; description: string | null; kind: string; kindByYou: boolean }[])
        .map((row) => ({ source: row.source, date: row.date, description: row.description, kind: row.kind, kindByYou: row.kindByYou }))
        .reverse();
    // An import from before imports kept transactions (days, none of its own): Plaid's still count on its days.
    const daysOnly: ImportedFile = { kind: 'balances', rows: [{ date: '2026-06-01', balance: 2000 }, { date: '2026-09-30', balance: 2050 }] };
    const first = await api('/api/imports', { method: 'POST', json: { accounts: [{ label: '··1234', target: { accountId: brk.id }, file: daysOnly }] } });
    expect(first.status).toBe(200);
    await settle(deps);
    expect((await listed()).map((row) => [row.source, row.date])).toEqual([
      ['plaid', '2026-07-16'],
      ['plaid', '2026-09-04'],
      ['plaid', '2026-10-01'],
    ]);

    // A kind you set on Plaid's withdrawal goes with it to the file's.
    const [p2] = await deps.db.select().from(schema.transactions).where(eq(schema.transactions.externalId, 'p-2'));
    expect((await api(`/api/transactions/${p2.id}`, { method: 'PATCH', json: { kind: 'fee' } })).status).toBe(200);

    const history = HISTORY.map((row) => (row.id === 'F5' ? { ...row, description: 'From checking to sav' } : row));
    const file = { ...download(20, 50, history), asOf: '2026-09-03' };
    expect((await api('/api/imports', { method: 'POST', json: { accounts: [{ label: '··1234', target: { accountId: brk.id }, file }] } })).status).toBe(200);
    await settle(deps);
    expect(await listed()).toEqual([
      { source: 'import', date: '2026-05-29', description: null, kind: 'buy', kindByYou: false },
      { source: 'import', date: '2026-06-01', description: 'From checking', kind: 'deposit', kindByYou: false },
      { source: 'import', date: '2026-07-15', description: 'dividend', kind: 'income', kindByYou: false },
      { source: 'import', date: '2026-09-01', description: null, kind: 'sell', kindByYou: false },
      { source: 'import', date: '2026-09-02', description: 'From checking to savings', kind: 'fee', kindByYou: true },
      { source: 'plaid', date: '2026-10-01', description: 'dividend', kind: 'income', kindByYou: false },
    ]);
    // All Plaid's are still stored.
    expect((await deps.db.select().from(schema.transactions).where(and(eq(schema.transactions.accountId, brk.id), eq(schema.transactions.source, 'plaid')))).length).toBe(3);

    // Plaid sends an older one, so the history is rebuilt: the file's days stay the file's.
    plaid.state.transactions.push(plaidRow('p-0', '2026-05-01', 'deposit', null, -100));
    deps.now = () => new Date(new Date(TODAY).getTime() + 2 * 86400_000);
    const [connection] = await deps.db.select().from(schema.connections);
    expect((await api(`/api/connections/${connection.id}/sync`, { method: 'POST' })).status).toBe(200);
    await settle(deps);
    const days = await deps.db.select({ date: schema.accountDaily.date, source: schema.accountDaily.source }).from(schema.accountDaily).where(eq(schema.accountDaily.accountId, brk.id));
    const fileDays = days.filter((day) => day.date >= '2026-05-29' && day.date <= '2026-09-03');
    expect(fileDays.length).toBeGreaterThan(90);
    expect(fileDays.every((day) => day.source === 'import')).toBe(true);
    expect(days.some((day) => day.date < '2026-05-29' && day.source === 'rebuilt')).toBe(true);
    expect((await listed()).map((row) => [row.source, row.date])[0]).toEqual(['plaid', '2026-05-01']);
  });
});
