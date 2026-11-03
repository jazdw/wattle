import { and, eq, or } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../server/db/schema';
import { ProviderHttpError } from '../server/adapters/marketData';
import { fundPrice } from '../server/services/holdingsImport';
import type { ImportedFile, ImportKind } from '../shared/schemas';
import { closes, fakePrices } from './fakes';
import { client, createHousehold, createTestDeps, nightly, settle, TODAY } from './helpers';

type Txn = { date: string; kind: ImportKind; fund: string | null; shares?: number; price?: number; amount?: number; value?: number; charges?: number };

const FUNDS = [
  { id: '000000001', ticker: null, name: 'Example Index Fund' },
  { id: '000000002', ticker: null, name: 'Example Index Fund M' },
  { id: '000000003', ticker: null, name: 'Example Target 2050' },
  { id: 'VTI', ticker: 'VTI', name: 'Vanguard Total Stock Market ETF' },
];

/**
 * A made-up plan download as the readers send it: amounts in dollars here,
 * sent in cents. A trade's total is its shares × price unless given, and
 * its cash moves the other way (a plan without cash ignores it).
 */
function download(positions: { fund: string; shares: number; price?: number }[], transactions: Txn[], options: { currency?: string; cash?: number } = {}) {
  return {
    kind: 'holdings' as const,
    currency: options.currency ?? 'USD',
    asOf: TODAY,
    securities: FUNDS,
    positions: positions.map((row) => ({ security: row.fund, shares: row.shares, ...(row.price !== undefined ? { price: row.price } : {}) })),
    cash: Math.round((options.cash ?? 0) * 100),
    transactions: transactions.map((txn) => {
      const value = Math.round((txn.value ?? Math.abs(txn.shares ?? 0) * (txn.price ?? 0)) * 100);
      const amount = txn.amount !== undefined ? Math.round(txn.amount * 100) : txn.kind === 'buy' ? -value : txn.kind === 'sell' ? value : 0;
      return { shares: 0, price: 0, label: txn.kind, ...txn, security: txn.fund, amount, value, charges: Math.round((txn.charges ?? 0) * 100) };
    }),
  };
}

/**
 * 40 shares of the index fund and 50.05 of the target fund before June: 10
 * more bought, then all 50 switched into the M class (250 at $12), 10 more of
 * that bought, and a fee taken from the target fund.
 */
const HISTORY: Txn[] = [
  { date: '2026-06-01', kind: 'buy', fund: '000000001', shares: 10, price: 50 },
  { date: '2026-07-01', kind: 'sell', fund: '000000001', shares: -50, price: 60 },
  { date: '2026-07-01', kind: 'buy', fund: '000000002', shares: 250, price: 12 },
  { date: '2026-08-03', kind: 'buy', fund: '000000002', shares: 10, price: 12.5 },
  { date: '2026-08-17', kind: 'sell', fund: '000000003', shares: -0.05, price: 20 },
];
const NOW = [
  { fund: '000000002', shares: 260, price: 13 },
  { fund: '000000003', shares: 50, price: 21 },
];

type File = ImportedFile;
type Target = { accountId: string } | { new: { name: string; type: string; currency: string; institutionName?: string; mask?: string; ownerUserId?: string | null } };

async function household(type = 'investment', limited = false) {
  const prices = fakePrices({ VTI: closes('2025-09-01', 450, 100) });
  // The market data provider saying "too many requests".
  const fetchCloses = prices.dailyCloses;
  if (limited) prices.dailyCloses = async (ticker) => Promise.reject(new ProviderHttpError(`Tiingo ${ticker}`, 429));
  /** The provider answering again. */
  const recover = () => void (prices.dailyCloses = fetchCloses);
  const deps = await createTestDeps({ prices });
  const home = await createHousehold(deps, 'Home', 'me@example.com');
  const api = client(deps, home.cookie);
  const accountId = (await api('/api/accounts', { method: 'POST', json: { name: '401(k)', type, currency: 'USD', balance: 100000 } })).body.id as string;
  const importing = (accounts: { label?: string; target: Target; file: File }[]) => api('/api/imports', { method: 'POST', json: { accounts: accounts.map((entry) => ({ label: '··1234', ...entry })) } });
  const send = (file: File) => importing([{ target: { accountId }, file }]);
  const day = async (date: string, id = accountId) => (await deps.db.select().from(schema.accountDaily).where(and(eq(schema.accountDaily.accountId, id), eq(schema.accountDaily.date, date))))[0];
  const position = async (date: string, name: string, id = accountId) => {
    const rows = await deps.db
      .select()
      .from(schema.holdingDaily)
      .innerJoin(schema.securities, eq(schema.securities.id, schema.holdingDaily.securityId))
      .where(and(eq(schema.holdingDaily.accountId, id), eq(schema.holdingDaily.date, date), or(eq(schema.securities.name, name), eq(schema.securities.ticker, name))));
    return rows[0]?.holding_daily;
  };
  return { deps, api, home, accountId, importing, send, day, position, recover };
}

describe('fundPrice', () => {
  const points: [string, number][] = [
    ['2026-06-01', 50],
    ['2026-07-01', 60],
  ];
  it("is the institution's price on its days, a straight line between them, and the nearest held beyond", () => {
    expect(fundPrice(points, '2026-06-01')).toEqual({ price: 50, source: 'institution' });
    expect(fundPrice(points, '2026-06-16')).toEqual({ price: 55, source: 'interpolated' });
    expect(fundPrice(points, '2026-05-20')).toEqual({ price: 50, source: 'interpolated' });
    expect(fundPrice(points, '2026-08-01')).toEqual({ price: 60, source: 'interpolated' });
    expect(fundPrice([], '2026-08-01')).toBeNull();
  });
});

describe('import into a manual account', () => {
  it('works out each day from the positions and transactions, priced from the file, through today', async () => {
    const { deps, accountId, send, day, position } = await household();
    const response = await send(download(NOW, HISTORY));
    expect(response.status).toBe(200);
    expect(response.body.accounts).toMatchObject([{ accountId, created: false, from: '2026-06-01', to: TODAY }]);
    await settle(deps);

    expect(await day('2026-05-31')).toBeUndefined(); // nothing before the first transaction
    // 50 index shares at $50, and 50.05 target shares at its first known price ($20) held back.
    expect(await day('2026-06-01')).toMatchObject({ balance: 2500_00 + 1001_00, source: 'import', priceSource: 'interpolated' });
    expect(await position('2026-06-16', 'Example Index Fund')).toMatchObject({ quantity: 50, price: 55, value: 2750_00, priceSource: 'interpolated' });
    // The switch: the index fund is gone, the M class holds the same money.
    expect(await position('2026-07-01', 'Example Index Fund')).toBeUndefined();
    expect(await position('2026-07-01', 'Example Index Fund M')).toMatchObject({ quantity: 250, price: 12, priceSource: 'institution' });
    expect(await position('2026-08-17', 'Example Target 2050')).toMatchObject({ quantity: 50 });
    // A plan with no cash: its contributions buy the funds directly, so there's no cash on any day.
    expect(await position('2026-06-01', 'Cash')).toBeUndefined();
    // Today replaces the balance entered by hand: 260 × $13 + 50 × $21.
    expect(await day(TODAY)).toMatchObject({ balance: 4430_00, source: 'import' });

    // The positions are the account's holdings now, priced as the file last was.
    const held = await deps.db.select().from(schema.holdings).innerJoin(schema.securities, eq(schema.securities.id, schema.holdings.securityId)).where(eq(schema.holdings.accountId, accountId));
    expect(held.map((row) => [row.securities.name, row.holdings.quantity, row.securities.lastPrice, row.securities.isPublic])).toEqual(
      expect.arrayContaining([
        ['Example Index Fund M', 260, 13, false],
        ['Example Target 2050', 50, 21, false],
      ]),
    );
  });

  it('refuses a file that doesn’t add up, writing nothing', async () => {
    const { deps, send } = await household();
    const imported = async () => (await deps.db.select().from(schema.accountDaily)).filter((row) => row.source === 'import').length;

    const short = await send(download([{ fund: '000000002', shares: 100, price: 13 }, NOW[1]], HISTORY));
    expect(short.status).toBe(409);
    expect(short.body.error).toMatch(/··1234: before 2026-07-01, Example Index Fund M would have -160\.0000 shares/);

    const mistotalled = await send(download(NOW, [{ ...HISTORY[0], value: 520 }, ...HISTORY.slice(1)]));
    expect(mistotalled.status).toBe(409);
    expect(mistotalled.body.error).toMatch(/on 2026-06-01, Example Index Fund shows 520 for 10 shares at 50/);

    const otherCurrency = await send(download(NOW, HISTORY, { currency: 'AUD' }));
    expect(otherCurrency.status).toBe(409);
    expect(otherCurrency.body.error).toMatch(/the file is in AUD but 401\(k\) is in USD/);

    await settle(deps);
    expect(await imported()).toBe(0);
  });

  it('allows for charges and rounded share counts, and puts holdings only in investment accounts', async () => {
    const { send } = await household();
    // $500 of shares plus a $5 commission.
    expect((await send(download(NOW, [{ ...HISTORY[0], value: 505, charges: 5 }, ...HISTORY.slice(1)]))).status).toBe(200);
    // A $20.46 dividend reinvested as 0.131 shares (rounded) at $156.47: $20.50 by shares × price.
    const reinvested: Txn = { date: '2026-09-25', kind: 'reinvest', fund: '000000003', shares: 0.131, price: 156.47, value: 20.46 };
    expect((await send(download([NOW[0], { ...NOW[1], shares: 50.131 }], [...HISTORY, reinvested]))).status).toBe(200);
    const savings = await household('depository');
    const refused = await savings.send(download(NOW, HISTORY));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/holdings go in an investment account/);
  });

  it('a second import replaces the first, and keeps a classification you set', async () => {
    const { deps, send, day } = await household();
    await send(download(NOW, HISTORY));
    await settle(deps);
    const [fund] = await deps.db.select().from(schema.securities).where(eq(schema.securities.name, 'Example Index Fund M'));
    await deps.db.update(schema.securities).set({ classification: { categories: { us_stock: 1 } }, classificationSource: 'user' }).where(eq(schema.securities.id, fund.id));

    // A later download: one more purchase, at a new price.
    const later = download([{ ...NOW[0], shares: 270 }, NOW[1]], [...HISTORY, { date: '2026-09-01', kind: 'buy', fund: '000000002', shares: 10, price: 13 }]);
    expect((await send(later)).status).toBe(200);
    await settle(deps);
    expect(await day(TODAY)).toMatchObject({ balance: 270 * 13_00 + 50 * 21_00 });
    const [again] = await deps.db.select().from(schema.securities).where(eq(schema.securities.id, fund.id));
    expect(again.classificationSource).toBe('user');
  });

  it('keeps cash, prices a market fund at its close and a plan fund from the file', async () => {
    const { deps, send, day, position } = await household();
    // $1,000 in, 5 VTI bought at $100, a $10 dividend paid out, $20 of fees: $490 cash left.
    const history: Txn[] = [
      { date: '2026-06-01', kind: 'deposit', fund: null, amount: 1000 },
      { date: '2026-06-02', kind: 'buy', fund: 'VTI', shares: 5, price: 100 },
      { date: '2026-06-02', kind: 'buy', fund: '000000003', shares: 10, price: 20, amount: 0 },
      { date: '2026-07-01', kind: 'income', fund: 'VTI', amount: 10 },
      { date: '2026-08-01', kind: 'fee', fund: null, amount: -20 },
    ];
    expect((await send(download([{ fund: 'VTI', shares: 5 }, { fund: '000000003', shares: 10, price: 21 }], history, { cash: 490 }))).status).toBe(200);
    await settle(deps);
    expect(await day('2026-05-31')).toBeUndefined();
    expect(await day('2026-06-01')).toMatchObject({ balance: 1000_00 });
    expect(await position('2026-06-15', 'VTI')).toMatchObject({ quantity: 5, price: 100, priceSource: 'close' });
    expect(await position('2026-06-02', 'Example Target 2050')).toMatchObject({ quantity: 10, price: 20, priceSource: 'institution' });
    expect(await position('2026-07-01', 'Cash')).toMatchObject({ quantity: 510 });
    expect(await position('2026-08-01', 'Cash')).toMatchObject({ quantity: 490 });
    expect(await day(TODAY)).toMatchObject({ balance: 490_00 + 5 * 100_00 + 10 * 21_00 });
    // The provider couldn't describe VTI: it's named as the file names it.
    const [vti] = await deps.db.select().from(schema.securities).where(eq(schema.securities.ticker, 'VTI'));
    expect(vti.name).toBe('Vanguard Total Stock Market ETF');
  });
});

describe('import while market prices can’t be fetched', () => {
  it('prices market funds from the file instead, as estimates, and says which', async () => {
    const { deps, send, position } = await household('investment', true);
    const history: Txn[] = [
      { date: '2026-06-01', kind: 'deposit', fund: null, amount: 1000 },
      { date: '2026-06-02', kind: 'buy', fund: 'VTI', shares: 5, price: 100 },
      { date: '2026-08-03', kind: 'buy', fund: 'VTI', shares: 5, price: 120 },
    ];
    const response = await send(download([{ fund: 'VTI', shares: 10, price: 130 }], history, { cash: -100 }));
    expect(response.status).toBe(200);
    expect(response.body.accounts[0].estimated).toEqual(['VTI']);
    await settle(deps);
    expect(await position('2026-06-02', 'VTI')).toMatchObject({ quantity: 5, price: 100, priceSource: 'institution' });
    expect(await position('2026-07-03', 'VTI')).toMatchObject({ quantity: 5, priceSource: 'interpolated' });
  });

  it('prices them at each day’s close overnight, once the provider answers', async () => {
    const { deps, send, day, position, recover } = await household('investment', true);
    const history: Txn[] = [{ date: '2026-06-02', kind: 'buy', fund: 'VTI', shares: 5, price: 90, amount: 0 }];
    await send(download([{ fund: 'VTI', shares: 5, price: 130 }], history));
    await settle(deps);
    expect(await day('2026-07-03')).toMatchObject({ priceSource: 'interpolated', source: 'import' });

    recover();
    await nightly(deps);
    await settle(deps);
    // The fake's VTI closes at $100 every day.
    expect(await position('2026-06-02', 'VTI')).toMatchObject({ price: 100, value: 500_00, priceSource: 'close' });
    expect(await position('2026-07-03', 'VTI')).toMatchObject({ price: 100, value: 500_00, priceSource: 'close' });
    expect(await day('2026-07-03')).toMatchObject({ balance: 500_00, priceSource: 'close', source: 'import' });
  });
});

describe('import of several accounts', () => {
  it('imports each account in one go, creating new ones', async () => {
    const { deps, api, home, accountId, importing, day } = await household();
    const response = await importing([
      { label: '··1234', target: { accountId }, file: download(NOW, HISTORY) },
      { label: '··5678', target: { new: { name: 'Example Brokerage ··5678', type: 'investment', currency: 'USD', institutionName: 'Example Brokerage', mask: '5678', ownerUserId: home.userId } }, file: download([{ fund: 'VTI', shares: 5 }], [{ date: '2026-06-02', kind: 'buy', fund: 'VTI', shares: 5, price: 100, amount: 0 }]) },
      { label: 'Savings', target: { new: { name: 'Savings', type: 'depository', currency: 'USD' } }, file: { kind: 'balances', rows: [{ date: '2026-09-01', balance: 50 }, { date: '2026-09-03', balance: 70 }] } },
    ]);
    expect(response.status).toBe(200);
    const [, brokerage, savings] = response.body.accounts as { accountId: string; created: boolean; days: number }[];
    expect(brokerage).toMatchObject({ created: true });
    expect(savings).toMatchObject({ created: true, days: 3 });
    await settle(deps);

    const created = (await api('/api/accounts')).body.accounts as { id: string; name: string; source: string; mask: string | null; institutionName: string | null; ownerUserId: string | null }[];
    expect(created.find((row) => row.id === brokerage.accountId)).toMatchObject({ name: 'Example Brokerage ··5678', source: 'manual', mask: '5678', institutionName: 'Example Brokerage', ownerUserId: home.userId });
    expect(created.find((row) => row.id === savings.accountId)?.ownerUserId).toBeNull(); // joint when none is given
    expect(await day(TODAY, brokerage.accountId)).toMatchObject({ balance: 500_00, source: 'import' });
    expect(await day('2026-09-02', savings.accountId)).toMatchObject({ balance: 50_00, source: 'import' });
    expect(await day('2026-07-01')).toMatchObject({ source: 'import' });
  });

  it('gives a closed account, holding nothing now, a balance of nothing rather than none', async () => {
    const { deps, api, importing } = await household();
    const response = await importing([
      { target: { new: { name: 'Closed ··9999', type: 'investment', currency: 'USD' } }, file: download([], [{ date: '2026-06-02', kind: 'buy', fund: 'VTI', shares: 5, price: 100, amount: 0 }, { date: '2026-08-03', kind: 'sell', fund: 'VTI', shares: -5, price: 100, amount: 0 }]) },
    ]);
    expect(response.status).toBe(200);
    await settle(deps);
    const closed = ((await api('/api/accounts')).body.accounts as { id: string; balance: number | null }[]).find((row) => row.id === response.body.accounts[0].accountId);
    expect(closed?.balance).toBe(0);
  });

  it('writes nothing, and creates no account, when any account doesn’t check out', async () => {
    const { deps, api, accountId, importing } = await household();
    const response = await importing([
      { label: '··5678', target: { new: { name: 'New brokerage', type: 'investment', currency: 'USD' } }, file: download([{ fund: 'VTI', shares: 5 }], [{ date: '2026-06-02', kind: 'buy', fund: 'VTI', shares: 5, price: 100 }]) },
      { label: '··1234', target: { accountId }, file: download([{ fund: '000000002', shares: 100, price: 13 }, NOW[1]], HISTORY) },
    ]);
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/^Nothing was imported: ··1234: /);
    await settle(deps);
    expect(((await api('/api/accounts')).body.accounts as unknown[]).length).toBe(1);
    expect((await deps.db.select().from(schema.accountDaily)).filter((row) => row.source === 'import')).toHaveLength(0);
  });

  it('refuses one account chosen for two in the files', async () => {
    const { accountId, importing } = await household();
    const response = await importing([
      { label: '··1234', target: { accountId }, file: download(NOW, HISTORY) },
      { label: '··5678', target: { accountId }, file: download(NOW, HISTORY) },
    ]);
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/··5678: 401\(k\) is chosen for another account in the files too/);
  });
});

describe('ticker suggestions', () => {
  it("finds a ticker for a security named without one: yours by name, else the provider's search", async () => {
    const deps = await createTestDeps({ prices: fakePrices({}, undefined, { ABCD: { type: 'equity', name: 'Abcd Holdings Inc' }, EXMP: { type: 'equity', name: 'Example Partners' } }) });
    const home = await createHousehold(deps, 'Home', 'me@example.com');
    await deps.db.insert(schema.securities).values({ id: 's-xmpl', householdId: home.householdId, ticker: 'XMPL', name: 'Example Corp, Inc.', type: 'equity', currency: 'USD', isPublic: true, createdAt: 1 });
    const response = await client(deps, home.cookie)('/api/imports/tickers', {
      method: 'POST',
      json: {
        securities: [
          { id: '000000001', name: 'EXAMPLE CORP INC' },
          { id: '000000002', name: 'ABCD HOLDINGS INC SPONSORED ADR' },
          { id: '000000003', name: 'Example Target 2050 Trust' },
        ],
      },
    });
    expect(response.body.suggestions).toEqual([
      { id: '000000001', ticker: 'XMPL', from: 'yours' },
      { id: '000000002', ticker: 'ABCD', from: 'search' },
    ]);
  });
});
