import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../server/db/schema';
import { fundPrice } from '../server/services/holdingsImport';
import { client, createHousehold, createTestDeps, settle, TODAY } from './helpers';

type Txn = { date: string; type: string; fund: string; shares: number; price: number; amount?: number; charges?: number };

/** Made-up statements: amounts in dollars here, sent in cents (each total is its shares × price unless given). */
function statements(positions: { fund: string; shares: number; price: number }[], transactions: Txn[], currency = 'USD') {
  return {
    asOf: TODAY,
    currency,
    funds: [
      { id: '000000001', name: 'Example Index Fund' },
      { id: '000000002', name: 'Example Index Fund M' },
      { id: '000000003', name: 'Example Target 2050' },
    ],
    positions,
    transactions: transactions.map((txn) => ({ charges: 0, ...txn, amount: Math.round((txn.amount ?? Math.abs(txn.shares) * txn.price) * 100) })),
  };
}

/**
 * 40 shares of the index fund and 50.05 of the target fund before June: 10
 * more bought, then all 50 switched into the M class (250 at $12), 10 more of
 * that bought, and a fee taken from the target fund.
 */
const HISTORY: Txn[] = [
  { date: '2026-06-01', type: 'BUYMF', fund: '000000001', shares: 10, price: 50 },
  { date: '2026-07-01', type: 'SELLMF', fund: '000000001', shares: -50, price: 60 },
  { date: '2026-07-01', type: 'BUYMF', fund: '000000002', shares: 250, price: 12 },
  { date: '2026-08-03', type: 'BUYMF', fund: '000000002', shares: 10, price: 12.5 },
  { date: '2026-08-17', type: 'SELLMF', fund: '000000003', shares: -0.05, price: 20 },
];
const NOW = [
  { fund: '000000002', shares: 260, price: 13 },
  { fund: '000000003', shares: 50, price: 21 },
];

async function manualAccount(type = 'investment') {
  const deps = await createTestDeps();
  const home = await createHousehold(deps, 'Home', 'me@example.com');
  const api = client(deps, home.cookie);
  const accountId = (await api('/api/accounts', { method: 'POST', json: { name: '401(k)', type, currency: 'USD', balance: 100000 } })).body.id as string;
  const send = (file: ReturnType<typeof statements>) => api('/api/imports/fund-history', { method: 'POST', json: { accountId, ...file } });
  const day = async (date: string) => (await deps.db.select().from(schema.accountDaily).where(and(eq(schema.accountDaily.accountId, accountId), eq(schema.accountDaily.date, date))))[0];
  const position = async (date: string, name: string) => {
    const rows = await deps.db
      .select()
      .from(schema.holdingDaily)
      .innerJoin(schema.securities, eq(schema.securities.id, schema.holdingDaily.securityId))
      .where(and(eq(schema.holdingDaily.accountId, accountId), eq(schema.holdingDaily.date, date), eq(schema.securities.name, name)));
    return rows[0]?.holding_daily;
  };
  return { deps, api, accountId, send, day, position };
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

describe('fund history import (investment statements)', () => {
  it('works out each day from the positions and transactions, priced from the statements, through today', async () => {
    const { deps, accountId, send, day, position } = await manualAccount();
    const response = await send(statements(NOW, HISTORY));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ from: '2026-06-01', to: TODAY, funds: 2 });
    await settle(deps);

    expect(await day('2026-05-31')).toBeUndefined(); // nothing before the first transaction
    // 50 index shares at $50, and 50.05 target shares at its first known price ($20) held back.
    expect(await day('2026-06-01')).toMatchObject({ balance: 2500_00 + 1001_00, source: 'import', priceSource: 'interpolated' });
    expect(await position('2026-06-16', 'Example Index Fund')).toMatchObject({ quantity: 50, price: 55, value: 2750_00, priceSource: 'interpolated' });
    // The switch: the index fund is gone, the M class holds the same money.
    expect(await position('2026-07-01', 'Example Index Fund')).toBeUndefined();
    expect(await position('2026-07-01', 'Example Index Fund M')).toMatchObject({ quantity: 250, price: 12, priceSource: 'institution' });
    expect(await position('2026-08-17', 'Example Target 2050')).toMatchObject({ quantity: 50 });
    // Today replaces the balance entered by hand: 260 × $13 + 50 × $21.
    expect(await day(TODAY)).toMatchObject({ balance: 4430_00, source: 'import' });

    // The positions are the account's holdings now, priced as the statements last were.
    const held = await deps.db.select().from(schema.holdings).innerJoin(schema.securities, eq(schema.securities.id, schema.holdings.securityId)).where(eq(schema.holdings.accountId, accountId));
    expect(held.map((row) => [row.securities.name, row.holdings.quantity, row.securities.lastPrice, row.securities.isPublic])).toEqual(
      expect.arrayContaining([
        ['Example Index Fund M', 260, 13, false],
        ['Example Target 2050', 50, 21, false],
      ]),
    );
  });

  it('refuses statements that don’t add up, writing nothing', async () => {
    const { deps, send } = await manualAccount();
    const imported = async () => (await deps.db.select().from(schema.accountDaily)).filter((row) => row.source === 'import').length;

    const short = await send(statements([{ fund: '000000002', shares: 100, price: 13 }, NOW[1]], HISTORY));
    expect(short.status).toBe(409);
    expect(short.body.error).toMatch(/Example Index Fund M would have -160\.0000 shares/);

    const mistotalled = await send(statements(NOW, [{ ...HISTORY[0], amount: 520 }, ...HISTORY.slice(1)]));
    expect(mistotalled.status).toBe(409);
    expect(mistotalled.body.error).toMatch(/on 2026-06-01, Example Index Fund shows 520 for 10 shares at 50/);

    const otherCurrency = await send(statements(NOW, HISTORY, 'AUD'));
    expect(otherCurrency.status).toBe(409);
    expect(otherCurrency.body.error).toMatch(/in AUD but the account is in USD/);

    await settle(deps);
    expect(await imported()).toBe(0);
  });

  it('allows for charges and rounded share counts, and goes only in investment accounts', async () => {
    const { send } = await manualAccount();
    // $500 of shares plus a $5 commission.
    expect((await send(statements(NOW, [{ ...HISTORY[0], amount: 505, charges: 500 }, ...HISTORY.slice(1)]))).status).toBe(200);
    // A $20.46 dividend reinvested as 0.131 shares (rounded) at $156.47: $20.50 by shares × price.
    const reinvested: Txn = { date: '2026-09-25', type: 'REINVEST', fund: '000000003', shares: 0.131, price: 156.47, amount: 20.46 };
    expect((await send(statements([NOW[0], { ...NOW[1], shares: 50.131 }], [...HISTORY, reinvested]))).status).toBe(200);
    const savings = await manualAccount('depository');
    expect((await savings.send(statements(NOW, HISTORY))).status).toBe(409);
  });

  it('a second import replaces the first, and keeps a classification you set', async () => {
    const { deps, send, day } = await manualAccount();
    await send(statements(NOW, HISTORY));
    await settle(deps);
    const [fund] = await deps.db.select().from(schema.securities).where(eq(schema.securities.name, 'Example Index Fund M'));
    await deps.db.update(schema.securities).set({ classification: { categories: { us_stock: 1 } }, classificationSource: 'user' }).where(eq(schema.securities.id, fund.id));

    // A later download: one more purchase, at a new price.
    const later = statements([{ ...NOW[0], shares: 270 }, NOW[1]], [...HISTORY, { date: '2026-09-01', type: 'BUYMF', fund: '000000002', shares: 10, price: 13 }]);
    expect((await send(later)).status).toBe(200);
    await settle(deps);
    expect(await day(TODAY)).toMatchObject({ balance: 270 * 13_00 + 50 * 21_00 });
    const [again] = await deps.db.select().from(schema.securities).where(eq(schema.securities.id, fund.id));
    expect(again.classificationSource).toBe('user');
  });
});
