import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../server/db/schema';
import { Tenant } from '../server/db/tenant';
import { closeLookup, ensureCloses, fxLookup } from '../server/services/pricing';
import { snapshotHousehold } from '../server/services/snapshots';
import { closes, fakeFx, fakePrices } from './fakes';
import { client, createHousehold, createTestDeps, TODAY } from './helpers';

describe('daily closes', () => {
  it('fetches only the missing edges and carries the last close forward', async () => {
    const prices = fakePrices({ VTI: closes('2026-09-01', 40, 100, 1) });
    const deps = await createTestDeps({ prices });
    await ensureCloses(deps, ['vti'], '2026-09-10', '2026-09-20');
    await ensureCloses(deps, ['VTI'], '2026-09-10', '2026-09-20');
    expect(prices.calls).toEqual(['VTI:2026-09-10:2026-09-20']);

    await ensureCloses(deps, ['VTI'], '2026-09-01', '2026-09-25');
    expect(prices.calls.slice(1)).toEqual(['VTI:2026-09-01:2026-09-09', 'VTI:2026-09-21:2026-09-25']);

    const lookup = await closeLookup(deps, ['VTI'], '2026-09-01', '2026-10-05');
    expect(lookup('VTI', '2026-09-01')).toBe(100);
    expect(lookup('vti', '2026-09-25')).toBe(124);
    expect(lookup('VTI', '2026-10-05')).toBe(124); // carried forward past the stored range
    expect(lookup('VTI', '2026-08-01')).toBeNull();
    expect(lookup('ZZZ', '2026-09-10')).toBeNull();
  });

  it('remembers tickers the provider does not know', async () => {
    const prices = fakePrices({});
    const deps = await createTestDeps({ prices });
    await ensureCloses(deps, ['PRIVATE'], '2026-09-01', '2026-09-10');
    await ensureCloses(deps, ['PRIVATE'], '2026-09-01', '2026-09-10');
    expect(prices.calls).toHaveLength(1);
  });

  it('survives provider failures', async () => {
    const deps = await createTestDeps({
      prices: {
        dailyCloses: async () => {
          throw new Error('HTTP 500');
        },
      },
    });
    await expect(ensureCloses(deps, ['VTI'], '2026-09-01', '2026-09-10')).resolves.toBeUndefined();
  });
});

describe('FX', () => {
  it('fetches rates on demand once, then serves as-of lookups', async () => {
    const fx = fakeFx(1.5);
    const deps = await createTestDeps({ fx });
    const lookup = await fxLookup(deps, '2026-10-01', TODAY);
    expect(lookup(TODAY)).toEqual({ 'USD->AUD': 1.5 });
    await fxLookup(deps, '2026-10-01', TODAY);
    expect(fx.calls).toHaveLength(1);
  });

  it('returns no rates when none are known', async () => {
    const deps = await createTestDeps();
    expect((await fxLookup(deps, '2026-10-01', TODAY))(TODAY)).toEqual({});
  });
});

async function household(options: Parameters<typeof createTestDeps>[0] = {}) {
  const deps = await createTestDeps(options);
  const home = await createHousehold(deps, 'Home', 'me@example.com');
  const api = client(deps, home.cookie);
  const tenant = new Tenant(deps.db, home.householdId);
  const create = async (body: Record<string, unknown>) =>
    (await api('/api/accounts', { method: 'POST', json: { currency: 'USD', ...body } })).body.id as string;
  return { deps, home, api, tenant, create };
}

describe('snapshots', () => {
  it('values public holdings at the close and private ones at the last unit price', async () => {
    const prices = fakePrices({ VTI: closes('2026-09-25', 20, 200) });
    const { deps, api, tenant, create } = await household({ prices });
    const id = await create({ name: 'Manual brokerage', type: 'investment' });
    await api(`/api/accounts/${id}/holdings`, {
      method: 'PUT',
      json: { holdings: [{ ticker: 'VTI', quantity: 2 }, { ticker: 'PLANFUND', name: 'Plan Trust 2055', quantity: 10, price: 30 }] },
    });
    await snapshotHousehold(deps, tenant, TODAY);
    const rows = await deps.db.select().from(schema.holdingDaily).where(eq(schema.holdingDaily.date, TODAY));
    expect(rows.map((row) => row.value).sort((a, b) => a - b)).toEqual([300_00, 400_00]);
    const [account] = await deps.db.select().from(schema.accounts).where(eq(schema.accounts.id, id));
    expect(account.balance).toBe(700_00); // manual accounts with holdings take their balance from them

    // Holdings that can't be priced are reported.
    const unpriced = await api(`/api/accounts/${id}/holdings`, { method: 'PUT', json: { holdings: [{ ticker: 'NOPE', quantity: 1 }] } });
    expect(unpriced.body.unpriced).toBe(1);
  });

  it('carries manual balances forward without overwriting entered values', async () => {
    const { deps, api, tenant, create } = await household();
    const id = await create({ name: 'Super', type: 'investment', balance: 1000, date: '2026-10-01' });
    await snapshotHousehold(deps, tenant, TODAY);
    await api(`/api/accounts/${id}/balances`, { method: 'POST', json: { date: '2026-10-05', balance: 1200 } });
    await snapshotHousehold(deps, tenant, TODAY);
    const rows = await deps.db.select().from(schema.accountDaily).where(eq(schema.accountDaily.accountId, id)).orderBy(schema.accountDaily.date);
    expect(rows.map((row) => [row.date, row.balance])).toEqual([
      ['2026-10-01', 1000_00],
      ['2026-10-05', 1200_00],
      [TODAY, 1200_00],
    ]);

    // An older entry is recorded without changing the current balance.
    await api(`/api/accounts/${id}/balances`, { method: 'POST', json: { date: '2026-09-01', balance: 800 } });
    const [account] = await deps.db.select().from(schema.accounts).where(eq(schema.accounts.id, id));
    expect(account.balance).toBe(1200_00);
    // The balance list shows what people entered, not daily snapshot copies.
    const listed = (await api(`/api/accounts/${id}/balances`)).body.balances;
    expect(listed.map((row: { date: string }) => row.date)).toEqual(['2026-10-05', '2026-10-01', '2026-09-01']);
  });
});

describe('history', () => {
  async function seeded() {
    const ctx = await household({ fx: fakeFx(2) });
    const usd = await ctx.create({ name: 'Checking', type: 'depository', balance: 100, date: '2026-10-01' });
    const aud = await ctx.create({ name: 'Westpac', type: 'depository', currency: 'AUD', balance: 400, date: '2026-10-03' });
    const loan = await ctx.create({ name: 'Mortgage', type: 'loan', balance: 50, date: '2026-10-01' });
    return { ...ctx, usd, aud, loan };
  }

  it('carries balances forward and converts each day at its FX rate', async () => {
    const { api } = await seeded();
    const history = (await api('/api/history?range=1M&group=total&currency=USD')).body;
    const value = (date: string) => history.series[0].values[history.dates.indexOf(date)];
    expect(history.dates.at(-1)).toBe(TODAY);
    expect(value('2026-09-30')).toBeNull();
    expect(value('2026-10-01')).toBe(100_00 - 50_00);
    expect(value('2026-10-02')).toBe(50_00);
    expect(value('2026-10-03')).toBe(50_00 + 200_00); // 400 AUD at 2 AUD/USD

    const inAud = (await api('/api/history?range=1M&group=total&currency=AUD')).body;
    expect(inAud.series[0].values.at(-1)).toBe(2 * 50_00 + 400_00);
  });

  it('groups by account and by category, with liabilities separate', async () => {
    const { api } = await seeded();
    const byAccount = (await api('/api/history?range=1M&group=account')).body;
    expect(byAccount.series.map((series: { label: string }) => series.label).sort()).toEqual(['Checking', 'Mortgage', 'Westpac']);

    const byCategory = (await api('/api/history?range=1M&group=category&currency=USD')).body;
    const keys = Object.fromEntries(byCategory.series.map((series: { key: string; values: number[] }) => [series.key, series.values.at(-1)]));
    expect(keys).toEqual({ cash: 300_00, liabilities: -50_00 });
  });

  it('supports every range and validates parameters', async () => {
    const { api } = await seeded();
    for (const range of ['1M', '3M', '6M', 'YTD', '1Y', '2Y', 'ALL']) {
      const response = await api(`/api/history?range=${range}`);
      expect(response.status, range).toBe(200);
    }
    expect((await api('/api/history?range=ALL')).body.dates[0]).toBe('2026-10-01');
    expect((await api('/api/history?range=YTD')).body.dates[0]).toBe('2026-01-01');
    expect((await api('/api/history?group=holding')).status).toBe(400);
  });

  it('splits holdings into categories by their classification', async () => {
    const prices = fakePrices({ VFFVX: closes('2026-09-25', 20, 50) });
    const { deps, api, tenant, create } = await household({ prices });
    const id = await create({ name: 'IRA', type: 'investment' });
    await api(`/api/accounts/${id}/holdings`, { method: 'PUT', json: { holdings: [{ ticker: 'VFFVX', quantity: 100 }] } });
    await snapshotHousehold(deps, tenant, TODAY);
    const byCategory = (await api('/api/history?range=1M&group=category')).body;
    const latest = Object.fromEntries(byCategory.series.map((series: { key: string; values: number[] }) => [series.key, series.values.at(-1)]));
    expect(Object.keys(latest).sort()).toEqual(['em_stock', 'intl_bond', 'intl_stock', 'us_bond', 'us_stock']);
    const total = Object.values(latest).reduce((sum: number, value) => sum + (value as number), 0);
    expect(Math.abs(total - 5000_00)).toBeLessThanOrEqual(5);
    const [row] = await deps.db.select().from(schema.holdingDaily).where(and(eq(schema.holdingDaily.accountId, id), eq(schema.holdingDaily.date, TODAY)));
    expect(row.price).toBe(50);
  });
});
