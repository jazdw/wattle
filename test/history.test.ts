import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../server/db/schema';
import { Tenant } from '../server/db/tenant';
import type { Deps } from '../server/ports';
import { reconstructHistory } from '../server/services/backfillCore';
import { ensureCloses, saveCloses } from '../server/services/pricing';
import { syncConnection } from '../server/services/sync';
import { account, closes, fakePlaid, fakePrices, holding, security, signWebhook } from './fakes';
import { client, createHousehold, createTestDeps, flush, settle, TODAY } from './helpers';

async function link(plaid: ReturnType<typeof fakePlaid>, overrides: Partial<Deps> = {}, kind: 'investments' | 'account' = 'investments') {
  const deps = await createTestDeps({ plaid, ...overrides });
  const home = await createHousehold(deps, 'Home', 'me@example.com');
  const api = client(deps, home.cookie);
  await api('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind } });
  await settle(deps, 20);
  const tenant = new Tenant(deps.db, home.householdId);
  const [connection] = await deps.db.select().from(schema.connections);
  return { deps, api, tenant, connection, plaid };
}

const buy = (id: string, date: string, quantity: number, price: number) => ({
  investment_transaction_id: id,
  account_id: 'brk',
  security_id: 's-vti',
  date,
  name: 'Buy VTI',
  type: 'buy',
  subtype: 'buy',
  quantity,
  amount: quantity * price,
  price,
  fees: 0,
  iso_currency_code: 'USD',
});

describe('transaction history arriving after the link', () => {
  it('every fetch asks for the full two years, so older transactions Plaid gets later are stored', async () => {
    const plaid = fakePlaid({
      accounts: [account('brk', 'investment', 1000)],
      securities: [security('s-vti', 'VTI', 'etf', 100)],
      holdings: [holding('brk', 's-vti', 10, 100)],
      transactions: [buy('t-recent', '2026-10-01', 2, 100)],
    });
    const { deps, tenant, connection } = await link(plaid);
    // Plaid now has an older one (it pulled more history from the institution).
    plaid.state.transactions.push(buy('t-old', '2025-12-01', 3, 90));
    deps.now = () => new Date('2026-10-09T12:00:00Z');
    await syncConnection(deps, tenant, connection.id, 'manual');
    const stored = await deps.db.select({ id: schema.investmentTransactions.externalId }).from(schema.investmentTransactions);
    expect(stored.map((row) => row.id).sort()).toEqual(['t-old', 't-recent']);
    expect(new Set(plaid.state.transactionStarts)).toEqual(new Set(['2024-10-08', '2024-10-09']));
  });
});

describe('Plaid webhooks kept', () => {
  it('stores each verified webhook, and HISTORICAL_UPDATE fetches transactions', async () => {
    const plaid = fakePlaid({
      accounts: [account('brk', 'investment', 1000)],
      securities: [security('s-vti', 'VTI', 'etf', 100)],
      holdings: [holding('brk', 's-vti', 10, 100)],
    });
    const { deps } = await link(plaid);
    const body = JSON.stringify({ webhook_type: 'INVESTMENTS_TRANSACTIONS', webhook_code: 'HISTORICAL_UPDATE', item_id: 'item-1' });
    const before = plaid.state.calls.length;
    const response = await client(deps)('/api/plaid/webhook', {
      method: 'POST',
      body,
      headers: { 'plaid-verification': await signWebhook(body, deps.now()), 'content-type': 'application/json', origin: 'https://plaid.com' },
    });
    expect(response.status).toBe(200);
    await flush(deps);
    expect(plaid.state.calls.slice(before).filter((call) => call === 'holdings' || call === 'transactions')).toEqual(['transactions']);
    const [kept] = await deps.db.select().from(schema.plaidWebhooks);
    expect(kept).toMatchObject({ event: 'INVESTMENTS_TRANSACTIONS:HISTORICAL_UPDATE', body });
  });
});

describe('bank history reports', () => {
  it("keep the report's posted transactions (not pending ones) and the response itself", async () => {
    const plaid = fakePlaid({
      accounts: [account('chk', 'depository', 1000)],
      historicalBalances: { chk: [{ date: '2026-10-01', current: 900 }] },
      reportTransactions: {
        chk: [
          { transaction_id: 'bt-1', date: '2026-10-01', amount: 100, original_description: 'Interest', pending: false },
          { transaction_id: 'bt-2', date: '2026-10-07', amount: -25.5, original_description: 'Coffee refund', pending: false },
          { transaction_id: 'bt-3', date: '2026-10-08', amount: 12, original_description: 'Pending card swipe', pending: true },
        ],
      },
    });
    const { deps } = await link(plaid, {}, 'account');
    const rows = await deps.db.select().from(schema.bankTransactions).orderBy(schema.bankTransactions.date);
    expect(rows.map((row) => [row.externalId, row.date, row.amount, row.description])).toEqual([
      ['bt-1', '2026-10-01', 100_00, 'Interest'],
      ['bt-2', '2026-10-07', -25_50, 'Coffee refund'],
    ]);
    const [report] = await deps.db.select().from(schema.plaidResponses).where(eq(schema.plaidResponses.endpoint, '/asset_report/get'));
    expect(JSON.parse(report.body).items[0].accounts[0].transactions).toHaveLength(3);
  });
});

describe('share splits', () => {
  it('walking back past a split divides the shares by its factor', () => {
    const days = reconstructHistory({
      start: '2026-03-13',
      end: '2026-03-17',
      holdings: [{ securityId: 'xyz', quantity: 200 }],
      transactions: [],
      cashSecurityId: null,
      price: (_id, date) => ({ price: date >= '2026-03-16' ? 75 : 300, estimated: false }),
      splitFactor: (_id, date) => (date === '2026-03-16' ? 4 : 1),
    });
    expect(days.map((day) => [day.date, day.positions[0].quantity, day.total])).toEqual([
      ['2026-03-13', 50, 15000_00],
      ['2026-03-14', 50, 15000_00],
      ['2026-03-15', 50, 15000_00],
      ['2026-03-16', 200, 15000_00],
      ['2026-03-17', 200, 15000_00],
    ]);
  });

  /** A brokerage holding 200 XYZ after a 4-for-1 split on 2026-03-16 (300 → 75). */
  function splitLogin(splitTransaction = false) {
    const series = closes('2024-10-01', 760, 0).map((row) => ({ ...row, close: row.date >= '2026-03-16' ? 75 : 300, ...(row.date === '2026-03-16' ? { splitFactor: 4 } : {}) }));
    const plaid = fakePlaid({
      accounts: [account('brk', 'investment', 200 * 75)],
      securities: [security('s-xyz', 'XYZ', 'etf', 75)],
      holdings: [holding('brk', 's-xyz', 200, 75)],
      transactions: splitTransaction
        ? [{ investment_transaction_id: 't-split', account_id: 'brk', security_id: 's-xyz', date: '2026-03-16', name: 'Split', type: 'transfer', subtype: 'split', quantity: 150, amount: 0, price: 0, fees: 0, iso_currency_code: 'USD' }]
        : [],
    });
    return { plaid, prices: fakePrices({ XYZ: series }) };
  }

  const heldOn = async (deps: Deps, date: string) => {
    const [row] = await deps.db.select().from(schema.holdingDaily).where(eq(schema.holdingDaily.date, date));
    return { quantity: row.quantity, value: row.value };
  };

  it("a history load uses the split factors in Tiingo's daily prices", async () => {
    const { plaid, prices } = splitLogin();
    const { deps } = await link(plaid, { prices });
    expect(await heldOn(deps, '2026-03-15')).toEqual({ quantity: 50, value: 15000_00 });
    expect(await heldOn(deps, '2026-03-16')).toEqual({ quantity: 200, value: 15000_00 });
  });

  it("a split the institution recorded as a transaction isn't applied twice", async () => {
    const { plaid, prices } = splitLogin(true);
    const { deps } = await link(plaid, { prices });
    expect(await heldOn(deps, '2026-03-15')).toEqual({ quantity: 50, value: 15000_00 });
  });

  it('a history load first fetches days stored without a split factor again, so a split among them counts', async () => {
    const { plaid, prices } = splitLogin();
    // Closes stored without split factors (as Tiingo's IEX endpoint saves them).
    const unknown = (await prices.dailyCloses('XYZ', '2024-10-01', TODAY)).map((row) => ({ ticker: 'XYZ', date: row.date, close: row.close, currency: 'USD', source: 'tiingo' }));
    const deps = await createTestDeps({ plaid, prices });
    await saveCloses(deps, unknown, { replace: false });
    const home = await createHousehold(deps, 'Home', 'me@example.com');
    await client(deps, home.cookie)('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'investments' } });
    await settle(deps, 20);
    expect(await heldOn(deps, '2026-03-15')).toEqual({ quantity: 50, value: 15000_00 });
    const factors = await deps.db.select().from(schema.pricesDaily).where(eq(schema.pricesDaily.ticker, 'XYZ'));
    // Within the two years the load covers (older days aren't needed, so they stay unknown).
    expect(factors.filter((row) => row.date >= '2024-10-08' && row.splitFactor === null)).toEqual([]);
    expect(factors.filter((row) => row.splitFactor !== null && row.splitFactor !== 1).map((row) => [row.date, row.splitFactor])).toEqual([['2026-03-16', 4]]);

    // Known now: asking for the same range again needs no request.
    const before = prices.calls.length;
    await ensureCloses(deps, ['XYZ'], '2024-10-08', TODAY);
    expect(prices.calls.slice(before)).toEqual([]);
  });

  it('a close saved without a split factor keeps the one already known', async () => {
    const deps = await createTestDeps();
    await saveCloses(deps, [{ ticker: 'XYZ', date: '2026-03-16', close: 75, currency: 'USD', source: 'tiingo', splitFactor: 4 }], { replace: true });
    await saveCloses(deps, [{ ticker: 'XYZ', date: '2026-03-16', close: 75.1, currency: 'USD', source: 'tiingo', splitFactor: null }], { replace: true });
    const [row] = await deps.db.select().from(schema.pricesDaily);
    expect(row).toMatchObject({ close: 75.1, splitFactor: 4 });
  });
});

describe('account transactions', () => {
  it("lists an investment account's transactions newest first with how far back they go, and a bank account's from its reports", async () => {
    const plaid = fakePlaid({
      accounts: [account('brk', 'investment', 1000), account('chk', 'depository', 500)],
      securities: [security('s-vti', 'VTI', 'etf', 100)],
      holdings: [holding('brk', 's-vti', 10, 100)],
      transactions: [buy('t1', '2026-09-01', 2, 100), buy('t2', '2026-10-01', 1, 100)],
      historicalBalances: { chk: [{ date: '2026-10-01', current: 500 }] },
      reportTransactions: { chk: [{ transaction_id: 'bt-1', date: '2026-10-02', amount: -1.5, original_description: 'Interest', pending: false }] },
      itemProducts: ['assets', 'investments'],
    });
    const { deps, api } = await link(plaid, {}, 'account');
    const accounts = (await api('/api/accounts')).body.accounts as { id: string; name: string }[];
    const id = (name: string) => accounts.find((row) => row.name === name)!.id;

    const brokerage = (await api(`/api/accounts/${id('brk')}/transactions`)).body;
    expect(brokerage).toMatchObject({ kind: 'investment', currency: 'USD', from: '2026-09-01', to: '2026-10-01', truncated: false });
    expect(brokerage.transactions.map((row: { date: string; ticker: string; quantity: number; amount: number }) => [row.date, row.ticker, row.quantity, row.amount])).toEqual([
      ['2026-10-01', 'VTI', 1, 100_00],
      ['2026-09-01', 'VTI', 2, 200_00],
    ]);
    const checking = (await api(`/api/accounts/${id('chk')}/transactions`)).body;
    expect(checking).toMatchObject({ kind: 'bank', from: '2026-10-02', transactions: [{ date: '2026-10-02', description: 'Interest', amount: -1_50 }] });

    // Another household's account isn't reachable.
    const other = await createHousehold(deps, 'Other', 'other@example.com');
    expect((await client(deps, other.cookie)(`/api/accounts/${id('brk')}/transactions`)).status).toBe(404);
  });
});
