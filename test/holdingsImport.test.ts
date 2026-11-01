import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../server/db/schema';
import type { ImportKind } from '../shared/schemas';
import { account, closes, fakePlaid, fakePrices, holding, security } from './fakes';
import { client, createHousehold, createTestDeps, settle, TODAY } from './helpers';

type Txn = { date: string; kind: ImportKind; ticker: string | null; shares?: number; price?: number; amount?: number };

/** A made-up download as the readers send it: positions now (a null ticker is cash) and transactions, amounts in dollars here, sent in cents. */
export function download(positions: { ticker: string | null; shares: number }[], transactions: Txn[]) {
  const tickers = [...new Set([...positions, ...transactions].flatMap((row) => (row.ticker ? [row.ticker] : [])))];
  return {
    kind: 'holdings' as const,
    asOf: TODAY,
    securities: tickers.map((ticker) => ({ id: ticker, ticker, name: ticker })),
    positions: positions.flatMap((row) => (row.ticker ? [{ security: row.ticker, shares: row.shares }] : [])),
    cash: Math.round(positions.filter((row) => !row.ticker).reduce((sum, row) => sum + row.shares, 0) * 100),
    transactions: transactions.map(({ ticker, ...txn }) => {
      const amount = Math.round((txn.amount ?? 0) * 100);
      return { shares: 0, price: 0, label: txn.kind, ...txn, security: ticker, amount, value: Math.abs(amount), charges: 0 };
    }),
  };
}

/** Buy 25 VTI the day before the $2,500 paying for it arrives, a $50 dividend, sell 5, withdraw the $500. */
const HISTORY: Txn[] = [
  { date: '2026-05-29', kind: 'buy', ticker: 'VTI', shares: 25, price: 100, amount: -2500 },
  { date: '2026-06-01', kind: 'deposit', ticker: null, amount: 2500 },
  { date: '2026-07-15', kind: 'income', ticker: 'VTI', amount: 50 },
  { date: '2026-09-01', kind: 'sell', ticker: 'VTI', shares: -5, price: 100, amount: 500 },
  { date: '2026-09-02', kind: 'withdrawal', ticker: null, amount: -500 },
];

/** A brokerage linked today holding `shares` VTI at $100 and $50 cash. */
async function linked(shares = 20) {
  const plaid = fakePlaid({
    accounts: [account('brk', 'investment', shares * 100 + 50)],
    securities: [security('s-vti', 'VTI', 'etf', 100), security('s-cash', 'CUR:USD', 'cash', 1, 'US Dollar')],
    holdings: [holding('brk', 's-vti', shares, 100), holding('brk', 's-cash', 50, 1)],
  });
  const deps = await createTestDeps({ plaid, prices: fakePrices({ VTI: closes('2024-09-01', 800, 100), BND: closes('2024-09-01', 800, 70) }) });
  const home = await createHousehold(deps, 'Home', 'me@example.com');
  const api = client(deps, home.cookie);
  await api('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'investments' } });
  await settle(deps);
  const [brk] = await deps.db.select().from(schema.accounts);
  const send = (file: ReturnType<typeof download>) => api('/api/imports', { method: 'POST', json: { accounts: [{ label: '··1234', target: { accountId: brk.id }, file }] } });
  const day = async (date: string) => (await deps.db.select().from(schema.accountDaily).where(and(eq(schema.accountDaily.accountId, brk.id), eq(schema.accountDaily.date, date))))[0];
  const vti = async (date: string) => {
    const [row] = await deps.db.select().from(schema.holdingDaily).innerJoin(schema.securities, eq(schema.securities.id, schema.holdingDaily.securityId)).where(and(eq(schema.holdingDaily.accountId, brk.id), eq(schema.holdingDaily.date, date), eq(schema.securities.ticker, 'VTI')));
    return row?.holding_daily;
  };
  return { deps, api, brk, send, day, vti };
}

describe('holdings history import', () => {
  it('works out each day from the positions and transactions, shares and cash on the trade date, up to the first synced day', async () => {
    const { deps, send, day, vti } = await linked();
    const response = await send(download([{ ticker: 'VTI', shares: 20 }, { ticker: null, shares: 50 }], HISTORY));
    expect(response.status).toBe(200);
    expect(response.body.accounts).toMatchObject([{ label: '··1234', created: false, from: '2026-05-29', to: '2026-10-07', days: 132 }]);
    await settle(deps);

    expect(await day('2026-05-28')).toBeUndefined(); // nothing before the first transaction
    // Bought before the money arrived: the shares, less the $2,500 owed until it does.
    expect(await day('2026-05-29')).toMatchObject({ balance: 0, source: 'import' });
    const [cash] = await deps.db.select().from(schema.securities).where(eq(schema.securities.ticker, 'CUR:USD'));
    const owed = await deps.db.select().from(schema.holdingDaily).where(and(eq(schema.holdingDaily.securityId, cash.id), eq(schema.holdingDaily.date, '2026-05-31')));
    expect(owed[0]).toMatchObject({ quantity: -2500, value: -2500_00 });
    // The money arrives: counted once, not alongside the shares it paid for.
    expect(await day('2026-06-01')).toMatchObject({ balance: 2500_00, source: 'import', priceSource: 'close' });
    expect(await day('2026-06-02')).toMatchObject({ balance: 2500_00 });
    expect(await day('2026-07-15')).toMatchObject({ balance: 2550_00 });
    expect(await vti('2026-08-31')).toMatchObject({ quantity: 25, source: 'import' });
    expect(await vti('2026-09-01')).toMatchObject({ quantity: 20 });
    expect(await day('2026-09-02')).toMatchObject({ balance: 2050_00 });
    expect(await day(TODAY)).toMatchObject({ source: 'snapshot' }); // the synced day is left alone
  });

  it('counts a split from the transaction that records it', async () => {
    const { deps, send, vti } = await linked(40);
    const split: Txn = { date: '2026-08-10', kind: 'transfer', ticker: 'VTI', shares: 20 };
    expect((await send(download([{ ticker: 'VTI', shares: 40 }, { ticker: null, shares: 50 }], [...HISTORY.slice(0, 3), split, { ...HISTORY[3], shares: -5 }, HISTORY[4]]))).status).toBe(200);
    await settle(deps);
    expect(await vti('2026-08-09')).toMatchObject({ quantity: 25 });
    expect(await vti('2026-08-10')).toMatchObject({ quantity: 45 });
  });

  it('refuses a file it can’t trust, writing nothing', async () => {
    const { deps, send } = await linked();
    const rows = async () => (await deps.db.select().from(schema.accountDaily)).filter((row) => row.source === 'import').length;
    const positions = [{ ticker: 'VTI', shares: 20 }, { ticker: null, shares: 50 }];

    // A kind the readers never send.
    const unknown = await send(download(positions, [...HISTORY, { date: '2026-09-03', kind: 'transfer of assets' as ImportKind, ticker: 'VTI', shares: 1 }]));
    expect(unknown.status).toBe(400);

    const short = await send(download([{ ticker: 'VTI', shares: 2 }, { ticker: null, shares: 50 }], HISTORY));
    expect(short.status).toBe(409);
    expect(short.body.error).toMatch(/Nothing was imported: ··1234: before 2026-05-29, VTI would have -18\.0000 shares/);

    const mismatched = await send(download([{ ticker: 'VTI', shares: 19 }, { ticker: null, shares: 50 }], HISTORY));
    expect(mismatched.status).toBe(409);
    expect(mismatched.body.error).toMatch(/on 2026-10-08, VTI is 19 in the file but 20 synced/);

    const mispriced = await send(download(positions, [{ ...HISTORY[0], price: 150 }, ...HISTORY.slice(1)]));
    expect(mispriced.status).toBe(409);
    expect(mispriced.body.error).toMatch(/on 2026-05-29, VTI traded at 150 but closed at 100/);

    await settle(deps);
    expect(await rows()).toBe(0);
  });

  it("doesn't check a dividend reinvestment's price: it's the dividend over a rounded share count", async () => {
    const { deps, send } = await linked(20.1);
    const reinvested: Txn[] = [
      { date: '2026-07-15', kind: 'income', ticker: 'VTI', amount: 10 },
      { date: '2026-07-15', kind: 'reinvest', ticker: 'VTI', shares: 0.1, price: 108.4, amount: -10 },
    ];
    expect((await send(download([{ ticker: 'VTI', shares: 20.1 }, { ticker: null, shares: 50 }], [...HISTORY, ...reinvested]))).status).toBe(200);
    await settle(deps);
    expect((await deps.db.select().from(schema.accountDaily)).filter((row) => row.source === 'import').length).toBeGreaterThan(0);
  });

  it('a second import of the same days replaces the first, holdings it no longer has included', async () => {
    const { deps, send } = await linked();
    const positions = [{ ticker: 'VTI', shares: 20 }, { ticker: null, shares: 50 }];
    const bnd: Txn[] = [
      { date: '2026-06-10', kind: 'buy', ticker: 'BND', shares: 10, price: 70, amount: -700 },
      { date: '2026-06-20', kind: 'sell', ticker: 'BND', shares: -10, price: 70, amount: 700 },
    ];
    await send(download(positions, [...HISTORY, ...bnd]));
    await settle(deps);
    const bndRows = async () => {
      const [security] = await deps.db.select().from(schema.securities).where(eq(schema.securities.ticker, 'BND'));
      return (await deps.db.select().from(schema.holdingDaily).where(eq(schema.holdingDaily.securityId, security.id))).length;
    };
    expect(await bndRows()).toBe(10);
    await send(download(positions, HISTORY));
    await settle(deps);
    expect(await bndRows()).toBe(0);
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
