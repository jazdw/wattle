/**
 * Where an account's value came from: money in and out, dividends and
 * interest, fees, market gain or loss, and what can't be told apart.
 */
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../server/db/schema';
import type { ImportedFile } from '../shared/schemas';
import type { BreakdownRow, HistoryResponse } from '../shared/types';
import { closes, fakePrices } from './fakes';
import { client, createHousehold, createTestDeps, settle, TODAY } from './helpers';

type Row = { date: string; kind: 'buy' | 'sell' | 'reinvest' | 'income' | 'deposit' | 'withdrawal' | 'fee'; shares?: number; amount: number };

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
      const trade = row.kind === 'buy' || row.kind === 'sell' || row.kind === 'reinvest';
      return { ...row, label: row.kind, security: trade || row.kind === 'income' ? 'VTI' : null, shares: row.shares ?? 0, price: trade ? 100 : 0, amount, value: trade ? Math.abs(row.shares ?? 0) * 100_00 : 0, charges: 0 };
    }),
  };
}

/** VTI at $100 until Sep 15 2026, then $110. */
const PRICES = { VTI: [...closes('2025-09-01', 379, 100), ...closes('2026-09-15', 40, 110)] };

async function household() {
  const deps = await createTestDeps({ prices: fakePrices(PRICES) });
  const home = await createHousehold(deps, 'Home', 'me@example.com');
  const api = client(deps, home.cookie);
  const create = async (name: string, file: ImportedFile) => {
    const response = await api('/api/imports', { method: 'POST', json: { accounts: [{ label: name, target: { new: { name, type: 'investment', currency: 'USD' } }, file }] } });
    expect(response.status).toBe(200);
    await settle(deps);
    return response.body.accounts[0].accountId as string;
  };
  const history = async (accountId?: string) => (await api(`/api/history?range=ALL&group=source${accountId ? `&accountId=${accountId}` : ''}`)).body as HistoryResponse;
  return { deps, api, create, history };
}

/** Start + money in − money out + dividends − fees + market + not broken down = the end, exactly. */
function addsUp(row: BreakdownRow) {
  expect(row.start + row.moneyIn - row.moneyOut + row.income - row.fees + row.market + row.other, row.label).toBe(row.end);
}

describe('breakdown', () => {
  it('splits an account’s change into money in and out, dividends, fees and market gain or loss', async () => {
    const { create, history } = await household();
    // Buy 25 VTI the day before the $2,500 paying for it arrives, a $50 dividend, sell 5, withdraw $500, a $10 fee; VTI then rises $10.
    const id = await create('Brokerage', download(20, 40, [
      { date: '2026-05-29', kind: 'buy', shares: 25, amount: -2500 },
      { date: '2026-06-01', kind: 'deposit', amount: 2500 },
      { date: '2026-07-15', kind: 'income', amount: 50 },
      { date: '2026-09-01', kind: 'sell', shares: -5, amount: 500 },
      { date: '2026-09-02', kind: 'withdrawal', amount: -500 },
      { date: '2026-09-03', kind: 'fee', amount: -10 },
    ]));
    const found = await history(id);
    const [row] = found.breakdown!;
    expect(row).toEqual({ key: id, label: 'Brokerage', start: 0, end: 2240_00, moneyIn: 2500_00, moneyOut: 500_00, income: 50_00, fees: 10_00, market: 200_00, other: 0, needsType: 0 });
    addsUp(row);
    // The chart's parts, cumulative: the last day's are the row's.
    const last = (key: string) => found.series.find((series) => series.key === key)!.values.at(-1);
    expect([last('balance'), last('in'), last('out'), last('income'), last('fees'), last('market'), last('other')]).toEqual([2240_00, 2500_00, -500_00, 50_00, -10_00, 200_00, 0]);
    const date = found.dates.indexOf('2026-09-14');
    expect(found.series.find((series) => series.key === 'market')!.values[date]).toBe(0);
  });

  it("counts a reinvested dividend that moves no cash as a dividend, and a plan's buys as money in", async () => {
    const { create, history } = await household();
    // A plan holding no cash: contributions buy its fund directly, a dividend buys more of it.
    const id = await create('Plan', download(21, 0, [
      { date: '2026-06-01', kind: 'buy', shares: 20, amount: 0 },
      { date: '2026-07-01', kind: 'reinvest', shares: 1, amount: 0 },
      // A switch out of the fund and back in on one day: neither money in nor out.
      { date: '2026-08-03', kind: 'sell', shares: -21, amount: 0 },
      { date: '2026-08-03', kind: 'buy', shares: 21, amount: 0 },
    ]));
    const [row] = (await history(id)).breakdown!;
    expect(row).toMatchObject({ start: 2000_00, moneyIn: 0, moneyOut: 0, income: 100_00, market: 210_00, other: 0 });
    addsUp(row);
  });

  it('leaves what it can’t tell apart out of market gain or loss, and adds up for the household', async () => {
    const { api, create, history } = await household();
    await create('Brokerage', download(10, 0, [{ date: '2026-06-01', kind: 'deposit', amount: 1000 }, { date: '2026-06-02', kind: 'buy', shares: 10, amount: -1000 }]));
    // A manual account with balances only: no transactions to tell its change apart by.
    const savings = (await api('/api/accounts', { method: 'POST', json: { name: 'Savings', type: 'depository', currency: 'USD', balance: 300 } })).body.id as string;
    for (const [date, balance] of [['2026-05-01', 500], ['2026-08-01', 300]] as const) {
      expect((await api(`/api/accounts/${savings}/balances`, { method: 'POST', json: { date, balance } })).status).toBeLessThan(300);
    }
    const found = await history();
    const [total, ...accounts] = found.breakdown!;
    expect(total).toMatchObject({ key: 'household', label: 'Household' });
    for (const row of found.breakdown!) addsUp(row);
    // Its change: not broken down.
    expect(accounts.find((row) => row.label === 'Savings')).toMatchObject({ start: 500_00, moneyIn: 0, moneyOut: 0, market: 0, other: -200_00 });
    // Opened by its deposit on Jun 1 (after the range starts): money in, not a gain.
    expect(accounts.find((row) => row.label === 'Brokerage')).toMatchObject({ start: 0, moneyIn: 1000_00, market: 100_00, other: 0 });
    expect(total).toMatchObject({ start: 500_00, moneyIn: 1000_00, market: 100_00, other: -200_00 });
  });

  it('by category, carries the last day’s split over a day without holdings, as the balance is carried', async () => {
    const { deps, api, create } = await household();
    const id = await create('Brokerage', download(10, 0, [{ date: '2026-06-01', kind: 'deposit', amount: 1000 }, { date: '2026-06-02', kind: 'buy', shares: 10, amount: -1000 }]));
    // A missed day: the balance carries on, the holdings that day are gone.
    await deps.db.delete(schema.holdingDaily).where(and(eq(schema.holdingDaily.accountId, id), eq(schema.holdingDaily.date, '2026-07-01')));
    await deps.db.delete(schema.accountDaily).where(and(eq(schema.accountDaily.accountId, id), eq(schema.accountDaily.date, '2026-07-01')));
    const found = (await api(`/api/history?range=ALL&group=category&accountId=${id}`)).body as HistoryResponse;
    const position = found.dates.indexOf('2026-07-01');
    expect(found.series.find((series) => series.key === 'other')).toBeUndefined();
    expect(found.series.reduce((sum, series) => sum + (series.values[position] ?? 0), 0)).toBe(1000_00);
  });
});
