import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../server/db/schema';
import { account, closes, fakePlaid, fakePrices, holding, security } from './fakes';
import { client, createHousehold, createTestDeps, settle, TODAY } from './helpers';

type Txn = { date: string; settled?: string; type: string; ticker: string | null; shares?: number; price?: number; amount?: number };

/** A made-up download: positions now and transactions (amounts in dollars here, sent in cents). */
function download(positions: { ticker: string | null; shares: number }[], transactions: Txn[]) {
  return {
    positions,
    transactions: transactions.map((txn) => ({ settled: txn.date, shares: 0, price: 0, ...txn, amount: Math.round((txn.amount ?? 0) * 100) })),
  };
}

/** Deposit $2,500 and buy 25 VTI (settling the next day), a $50 dividend, sell 5 (settling the next day), withdraw the $500. */
const HISTORY: Txn[] = [
  { date: '2026-06-01', type: 'Funds Received', ticker: null, amount: 2500 },
  { date: '2026-06-01', settled: '2026-06-02', type: 'Buy', ticker: 'VTI', shares: 25, price: 100, amount: -2500 },
  { date: '2026-07-15', type: 'Dividend', ticker: 'VTI', amount: 50 },
  { date: '2026-09-01', settled: '2026-09-02', type: 'Sell', ticker: 'VTI', shares: -5, price: 100, amount: 500 },
  { date: '2026-09-02', type: 'Withdrawal', ticker: null, amount: -500 },
];

/** A brokerage linked today holding `shares` VTI at $100 and $50 cash. */
async function linked(shares = 20) {
  const plaid = fakePlaid({
    accounts: [account('brk', 'investment', shares * 100 + 50)],
    securities: [security('s-vti', 'VTI', 'etf', 100), security('s-cash', 'CUR:USD', 'cash', 1, 'US Dollar')],
    holdings: [holding('brk', 's-vti', shares, 100), holding('brk', 's-cash', 50, 1)],
  });
  const deps = await createTestDeps({ plaid, prices: fakePrices({ VTI: closes('2024-09-01', 800, 100) }) });
  const home = await createHousehold(deps, 'Home', 'me@example.com');
  const api = client(deps, home.cookie);
  await api('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'investments' } });
  await settle(deps);
  const [brk] = await deps.db.select().from(schema.accounts);
  const send = (file: ReturnType<typeof download>) => api('/api/imports/holdings-history', { method: 'POST', json: { accountId: brk.id, ...file } });
  const day = async (date: string) => (await deps.db.select().from(schema.accountDaily).where(and(eq(schema.accountDaily.accountId, brk.id), eq(schema.accountDaily.date, date))))[0];
  const vti = async (date: string) => {
    const [row] = await deps.db.select().from(schema.holdingDaily).innerJoin(schema.securities, eq(schema.securities.id, schema.holdingDaily.securityId)).where(and(eq(schema.holdingDaily.accountId, brk.id), eq(schema.holdingDaily.date, date), eq(schema.securities.ticker, 'VTI')));
    return row?.holding_daily;
  };
  return { deps, api, brk, send, day, vti };
}

describe('holdings history import', () => {
  it('works out each day from the positions and transactions, shares on the trade date and cash on settlement, up to the first synced day', async () => {
    const { deps, send, day, vti } = await linked();
    const response = await send(download([{ ticker: 'VTI', shares: 20 }, { ticker: null, shares: 50 }], HISTORY));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ from: '2026-06-01', to: '2026-10-07', days: 129 });
    await settle(deps);

    expect(await day('2026-05-31')).toBeUndefined(); // nothing before the first transaction
    expect(await day('2026-06-01')).toMatchObject({ balance: 5000_00, source: 'import' }); // bought, not yet paid
    expect(await day('2026-06-02')).toMatchObject({ balance: 2500_00, source: 'import', priceSource: 'close' });
    expect(await day('2026-07-15')).toMatchObject({ balance: 2550_00 });
    expect(await vti('2026-08-31')).toMatchObject({ quantity: 25, source: 'import' });
    expect(await vti('2026-09-01')).toMatchObject({ quantity: 20 });
    expect(await day('2026-09-02')).toMatchObject({ balance: 2050_00 });
    expect(await day(TODAY)).toMatchObject({ source: 'snapshot' }); // the synced day is left alone
  });

  it('counts a split from the transaction that records it', async () => {
    const { deps, send, vti } = await linked(40);
    const split: Txn = { date: '2026-08-10', type: 'Stock split', ticker: 'VTI', shares: 20 };
    expect((await send(download([{ ticker: 'VTI', shares: 40 }, { ticker: null, shares: 50 }], [...HISTORY.slice(0, 3), split, { ...HISTORY[3], shares: -5 }, HISTORY[4]]))).status).toBe(200);
    await settle(deps);
    expect(await vti('2026-08-09')).toMatchObject({ quantity: 25 });
    expect(await vti('2026-08-10')).toMatchObject({ quantity: 45 });
  });

  it('refuses a file it can’t trust, writing nothing', async () => {
    const { deps, send } = await linked();
    const rows = async () => (await deps.db.select().from(schema.accountDaily)).filter((row) => row.source === 'import').length;
    const positions = [{ ticker: 'VTI', shares: 20 }, { ticker: null, shares: 50 }];

    const unknown = await send(download(positions, [...HISTORY, { date: '2026-09-03', type: 'Transfer of assets', ticker: 'VTI', shares: 1 }]));
    expect(unknown.status).toBe(409);
    expect(unknown.body.error).toMatch(/doesn't understand yet: transfer of assets/);

    const mismatched = await send(download([{ ticker: 'VTI', shares: 19 }, { ticker: null, shares: 50 }], HISTORY));
    expect(mismatched.status).toBe(409);
    expect(mismatched.body.error).toMatch(/on 2026-10-08, VTI is 19 in the file but 20 synced/);

    const mispriced = await send(download(positions, [HISTORY[0], { ...HISTORY[1], price: 150 }, ...HISTORY.slice(2)]));
    expect(mispriced.status).toBe(409);
    expect(mispriced.body.error).toMatch(/on 2026-06-01, VTI traded at 150 but closed at 100/);

    await settle(deps);
    expect(await rows()).toBe(0);
  });

  it('keeps imported days when history is rebuilt from the institution’s transactions later', async () => {
    const { deps, api, send, day } = await linked();
    await send(download([{ ticker: 'VTI', shares: 20 }, { ticker: null, shares: 50 }], HISTORY));
    await settle(deps);
    const [connection] = await deps.db.select().from(schema.connections);
    expect((await api(`/api/connections/${connection.id}/backfill`, { method: 'POST' })).status).toBe(200);
    await settle(deps);
    expect(await day('2026-07-01')).toMatchObject({ balance: 2500_00, source: 'import' });
  });
});
