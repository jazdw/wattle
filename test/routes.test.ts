import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../server/db/schema';
import type { Deps } from '../server/ports';
import { runDaily } from '../server/services/jobs';
import { account, closes, fakeFx, fakePlaid, fakePrices, fakeQuotes, holding, security } from './fakes';
import { client, createHousehold, createTestDeps, flush, TODAY } from './helpers';

async function household(options: Partial<Deps> = {}) {
  const deps = await createTestDeps(options);
  const home = await createHousehold(deps, 'Home', 'me@example.com');
  const api = client(deps, home.cookie);
  const create = async (body: Record<string, unknown>) =>
    (await api('/api/accounts', { method: 'POST', json: { currency: 'USD', ...body } })).body.id as string;
  return { deps, home, api, create };
}

describe('accounts', () => {
  it('validates input and ownership', async () => {
    const { deps, api, create, home } = await household();
    expect((await api('/api/accounts', { method: 'POST', json: { name: '', type: 'depository', currency: 'USD' } })).status).toBe(400);
    expect((await api('/api/accounts', { method: 'POST', json: { name: 'X', type: 'yacht', currency: 'USD' } })).status).toBe(400);
    expect((await api('/api/accounts', { method: 'POST', body: 'not json', headers: { 'content-type': 'application/json' } })).status).toBe(400);

    const stranger = await createHousehold(deps, 'Other', 'other@example.com');
    const owned = await api('/api/accounts', {
      method: 'POST',
      json: { name: 'X', type: 'depository', currency: 'USD', ownerUserId: stranger.userId },
    });
    expect(owned.status).toBe(400);

    const id = await create({ name: 'Joint savings', type: 'depository', ownerUserId: null });
    expect((await api(`/api/accounts/${id}`, { method: 'PATCH', json: { ownerUserId: home.userId, name: 'Mine', category: 'cash', currency: 'AUD' } })).status).toBe(200);
    const [row] = await deps.db.select().from(schema.accounts).where(eq(schema.accounts.id, id));
    expect(row).toMatchObject({ ownerUserId: home.userId, name: 'Mine', category: 'cash', currency: 'AUD' });
  });

  it('stores liabilities as negative and deletes manual accounts with their history', async () => {
    const { deps, api, create } = await household();
    const card = await create({ name: 'Card', type: 'credit', balance: 250 });
    expect((await api('/api/portfolio')).body.liabilities).toBe(-250_00);
    expect((await api(`/api/accounts/${card}`, { method: 'DELETE' })).status).toBe(200);
    expect(await deps.db.select().from(schema.accountDaily)).toHaveLength(0);
  });

  it('protects linked accounts from manual edits', async () => {
    const plaid = fakePlaid({ accounts: [account('chk', 'depository', 100)] });
    const { deps, api } = await household({ plaid });
    await api('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'banking' } });
    await flush(deps);
    const [linked] = await deps.db.select().from(schema.accounts);
    expect((await api(`/api/accounts/${linked.id}`, { method: 'DELETE' })).status).toBe(409);
    expect((await api(`/api/accounts/${linked.id}/balances`, { method: 'POST', json: { date: TODAY, balance: 1 } })).status).toBe(409);
    expect((await api(`/api/accounts/${linked.id}/holdings`, { method: 'PUT', json: { holdings: [] } })).status).toBe(409);
  });
});

describe('portfolio', () => {
  it('respects target exclusions for allocation but not for net worth', async () => {
    const { api, create } = await household();
    const house = await create({ name: 'House', type: 'property', balance: 500000 });
    const emergency = await create({ name: 'Emergency', type: 'depository', balance: 20000 });
    await create({ name: 'Brokerage', type: 'investment', category: 'us_stock', balance: 80000 });

    expect((await api('/api/targets')).body.target).toBeNull();
    const put = await api('/api/targets', {
      method: 'PUT',
      json: { weights: { us_stock: 80, us_bond: 20 }, bandPct: 5, excludedAccountIds: [emergency], excludedCategories: ['real_estate'] },
    });
    expect(put.status).toBe(200);
    const target = (await api('/api/targets')).body.target;
    expect(target.weights).toEqual({ us_stock: 0.8, us_bond: 0.2 }); // normalised

    const portfolio = (await api('/api/portfolio')).body;
    expect(portfolio.netWorth).toBe(600000_00);
    expect(portfolio.categories).toMatchObject({ us_stock: 80000_00, cash: 0, real_estate: 0 });
    expect(portfolio.allCategories).toMatchObject({ real_estate: 500000_00, cash: 20000_00 });
    void house;

    // Updating replaces the active target.
    await api('/api/targets', { method: 'PUT', json: { weights: { us_stock: 1 }, bandPct: 3, excludedAccountIds: [], excludedCategories: [] } });
    expect((await api('/api/targets')).body.target.bandPct).toBe(3);
    expect((await api('/api/targets', { method: 'PUT', json: { weights: {}, bandPct: 3, excludedAccountIds: [], excludedCategories: [] } })).status).toBe(400);
  });

  it('converts to the requested display currency', async () => {
    const { api, create } = await household({ fx: fakeFx(1.5) });
    await create({ name: 'Westpac', type: 'depository', currency: 'AUD', balance: 150 });
    expect((await api('/api/portfolio?currency=USD')).body.netWorth).toBe(100_00);
    expect((await api('/api/portfolio?currency=AUD')).body.netWorth).toBe(150_00);
    expect((await api('/api/accounts?currency=USD')).body.accounts[0].displayBalance).toBe(100_00);
  });
});

describe('securities', () => {
  it('lets the household override a classification', async () => {
    const { deps, api, create } = await household();
    const id = await create({ name: 'IRA', type: 'investment' });
    await api(`/api/accounts/${id}/holdings`, { method: 'PUT', json: { holdings: [{ ticker: 'MYSTERY', quantity: 1, price: 10 }] } });
    const [sec] = (await api('/api/securities')).body.securities;
    expect(sec.needsReview).toBe(true);

    const patch = await api(`/api/securities/${sec.id}`, {
      method: 'PATCH',
      json: { classification: { categories: { us_stock: 3, us_bond: 1 }, sizes: { small: 1 }, styles: { value: 1 } } },
    });
    expect(patch.status).toBe(200);
    const [row] = await deps.db.select().from(schema.securities);
    expect(row.classification).toEqual({ categories: { us_stock: 0.75, us_bond: 0.25 }, sizes: { small: 1 }, styles: { value: 1 } });
    expect(row).toMatchObject({ classificationSource: 'user', needsReview: false });

    expect((await api(`/api/securities/${sec.id}`, { method: 'PATCH', json: { classification: { categories: {} } } })).status).toBe(400);
    expect((await api(`/api/securities/${sec.id}`, { method: 'PATCH', json: { classification: { categories: { gold: 1 } } } })).status).toBe(400);
  });
});

describe('quotes', () => {
  it('serves live quotes for stocks/ETFs (cached) and last closes for mutual funds', async () => {
    const quotes = fakeQuotes({ VTI: { price: 310, change: 2, changePercent: 0.0065 } });
    const prices = fakePrices({ VTI: closes('2026-10-01', 8, 300), VTSAX: closes('2026-10-01', 8, 150) });
    const plaid = fakePlaid({
      accounts: [account('brk', 'investment', 1000)],
      securities: [security('s-vti', 'VTI', 'etf', 300), security('s-vtsax', 'VTSAX', 'mutual fund', 150)],
      holdings: [holding('brk', 's-vti', 1, 300), holding('brk', 's-vtsax', 1, 150)],
    });
    const { deps, api } = await household({ quotes, prices, plaid });
    await api('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'investments' } });
    await flush(deps);

    const first = (await api('/api/quotes')).body;
    expect(first.quotes).toEqual([expect.objectContaining({ ticker: 'VTI', price: 310 })]);
    expect(first.closes).toEqual([{ ticker: 'VTSAX', close: 150, date: TODAY }]);
    await api('/api/quotes');
    expect(quotes.calls).toEqual(['VTI']);
  });
});

describe('imports', () => {
  it('imports balance history, filling gaps unless asked to overwrite', async () => {
    const { deps, api, create } = await household();
    const id = await create({ name: 'Westpac', type: 'depository', balance: 100, date: '2026-10-01' });
    const rows = [
      { date: '2026-10-01', balance: 999 },
      { date: '2026-09-30', balance: 90 },
    ];
    expect((await api('/api/imports/balances', { method: 'POST', json: { accountId: id, rows } })).body.imported).toBe(2);
    const balance = async (date: string) =>
      (await deps.db.select().from(schema.accountDaily).where(eq(schema.accountDaily.accountId, id))).find((row) => row.date === date)?.balance;
    expect(await balance('2026-10-01')).toBe(100_00); // entered value kept
    expect(await balance('2026-09-30')).toBe(90_00);

    await api('/api/imports/balances', { method: 'POST', json: { accountId: id, rows, overwrite: true } });
    expect(await balance('2026-10-01')).toBe(999_00);
  });

  it('imports holdings history and creates unknown securities', async () => {
    const { deps, api, create } = await household();
    const id = await create({ name: 'IRA', type: 'investment' });
    const response = await api('/api/imports/holdings', {
      method: 'POST',
      json: { accountId: id, rows: [{ date: '2026-09-01', ticker: 'vxus', quantity: 10, price: 60 }, { date: '2026-09-01', ticker: 'NEWFUND', quantity: 5 }] },
    });
    expect(response.body).toEqual({ imported: 2, newSecurities: 2 });
    const rows = await deps.db.select().from(schema.holdingDaily);
    expect(rows.find((row) => row.price === 60)?.value).toBe(600_00);
    expect(rows.find((row) => row.price === null)?.estimated).toBe(true);
  });

  it('refuses hidden accounts', async () => {
    const { api, create } = await household();
    const id = await create({ name: 'Old', type: 'depository' });
    await api(`/api/accounts/${id}`, { method: 'PATCH', json: { isHidden: true } });
    expect((await api('/api/imports/balances', { method: 'POST', json: { accountId: id, rows: [{ date: TODAY, balance: 1 }] } })).status).toBe(409);
  });
});

describe('household settings', () => {
  it('renames and changes the default currency', async () => {
    const { api } = await household();
    expect((await api('/api/household', { method: 'PATCH', json: { name: 'Wiltshires', displayCurrency: 'AUD' } })).status).toBe(200);
    expect((await api('/api/auth/me')).body.household).toMatchObject({ name: 'Wiltshires', displayCurrency: 'AUD' });
    expect((await api('/api/household', { method: 'PATCH', json: { displayCurrency: 'EUR' } })).status).toBe(400);
  });
});

describe('daily job', () => {
  it('requires the admin token', async () => {
    const { deps } = await household();
    const anonymous = client(deps);
    expect((await anonymous('/api/admin/run-daily', { method: 'POST' })).status).toBe(403);
    expect((await anonymous('/api/admin/run-daily', { method: 'POST', headers: { authorization: 'Bearer wrong' } })).status).toBe(403);
    const ok = await anonymous('/api/admin/run-daily', { method: 'POST', headers: { authorization: 'Bearer admin-secret' } });
    expect(ok.body).toMatchObject({ date: TODAY, households: 1, errors: [] });
  });

  it('syncs every household, isolates failures and snapshots the day', async () => {
    const plaid = fakePlaid({ accounts: [account('brk', 'investment', 1000)], securities: [security('s', 'VTI', 'etf', 100)], holdings: [holding('brk', 's', 10, 100)] });
    const { deps, api } = await household({ plaid });
    await api('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'investments' } });
    await flush(deps);
    const other = await createHousehold(deps, 'Other', 'other@example.com');
    await client(deps, other.cookie)('/api/accounts', { method: 'POST', json: { name: 'Cash', type: 'depository', currency: 'USD', balance: 5 } });

    plaid.state.holdings = [holding('brk', 's', 11, 100)];
    const report = await runDaily(deps);
    expect(report).toMatchObject({ households: 2, errors: [] });
    expect((await api('/api/portfolio')).body.netWorth).toBe(1100_00);

    // A broken provider is reported, and the other household is still snapshotted.
    plaid.getAccounts = async () => {
      throw new Error('network down');
    };
    const failed = await runDaily(deps);
    expect(failed.errors).toHaveLength(1);
    expect(failed.errors[0]).toContain('network down');
    const rows = await deps.db.select().from(schema.accountDaily).where(eq(schema.accountDaily.householdId, other.householdId));
    expect(rows.some((row) => row.date === TODAY)).toBe(true);
  });

  it('refresh syncs and snapshots for the signed-in household', async () => {
    const plaid = fakePlaid({ accounts: [account('chk', 'depository', 50)] });
    const { deps, api } = await household({ plaid });
    await api('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'banking' } });
    await flush(deps);
    await deps.db.update(schema.connections).set({ lastSyncedAt: null });
    expect((await api('/api/refresh', { method: 'POST' })).body.synced).toBe(1);
    expect((await api('/api/refresh', { method: 'POST' })).body.synced).toBe(0); // rate-limited
  });
});
