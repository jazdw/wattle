#!/usr/bin/env node
// LOCAL DEVELOPMENT ONLY: fill a dev household with demo accounts and a year
// of synthetic daily history, through the public API (dev sign-in).
//
//   npm run dev            # in another terminal
//   node scripts/seed-demo.mjs [http://localhost:5173] [demo@example.com]

const base = process.argv[2] ?? 'http://localhost:5173';
const email = process.argv[3] ?? 'demo@example.com';

const login = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
if (!cookie.startsWith('wt_session=')) throw new Error(`Dev sign-in failed (${login.status}). Is ${email} in DEV_LOGIN_EMAILS?`);

async function call(path, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { cookie, origin: base, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(json)}`);
  return json;
}

const DAYS = 365;
const today = new Date();
const dates = Array.from({ length: DAYS }, (_, index) => {
  const date = new Date(today);
  date.setUTCDate(date.getUTCDate() - (DAYS - 1 - index));
  return date.toISOString().slice(0, 10);
});

/** Deterministic random walk ending at `end`. */
function walk(end, volatility, drift, seed) {
  let state = seed;
  const random = () => ((state = (state * 16807) % 2147483647) / 2147483647) - 0.5;
  const values = [end];
  for (let index = 1; index < DAYS; index += 1) {
    values.unshift(values[0] / (1 + drift + random() * volatility));
  }
  return values;
}

const me = await call('/api/auth/me');
const owner = me.user.id;

async function account(spec, endBalance, volatility, drift, seed) {
  const { id } = await call('/api/accounts', 'POST', { ...spec, ownerUserId: spec.ownerUserId ?? owner });
  const series = walk(endBalance, volatility, drift, seed);
  const rows = dates.map((date, index) => ({ date, balance: Math.round(series[index] * 100) / 100 }));
  await call('/api/imports', 'POST', { accounts: [{ label: 'Demo', target: { accountId: id }, file: { kind: 'balances', rows } }] });
  await call(`/api/accounts/${id}/balances`, 'POST', { date: dates.at(-1), balance: endBalance });
  return id;
}

await account({ name: 'Northwind Checking (demo)', institutionName: 'Northwind', type: 'depository', currency: 'USD' }, 8500, 0.02, 0, 7);
await account({ name: 'Example Bank Everyday (demo)', institutionName: 'Example Bank', type: 'depository', currency: 'AUD' }, 12000, 0.02, 0.0002, 11);
await account({ name: 'Example Super (demo)', institutionName: 'Example Super Fund', type: 'investment', currency: 'AUD', category: 'au_stock' }, 185000, 0.006, 0.0003, 13);
await account({ name: 'Home (demo)', type: 'property', currency: 'AUD', ownerUserId: null }, 950000, 0.001, 0.0002, 17);
await account({ name: 'Mortgage (demo)', institutionName: 'Example Bank', type: 'loan', currency: 'AUD', ownerUserId: null }, 610000, 0.0005, -0.0001, 19);
await account({ name: 'Travel Card card (demo)', institutionName: 'Northwind', type: 'credit', currency: 'USD' }, 2300, 0.05, 0, 23);

// An investment account with holdings history.
const holdings = [
  { ticker: 'VTSAX', name: 'Vanguard Total Stock Market Index Admiral', quantity: 620, price: 152.4 },
  { ticker: 'VTIAX', name: 'Vanguard Total International Stock Index Admiral', quantity: 1400, price: 36.1 },
  { ticker: 'VBTLX', name: 'Vanguard Total Bond Market Index Admiral', quantity: 2600, price: 9.8 },
  { ticker: 'VFFVX', name: 'Vanguard Target Retirement 2055', quantity: 900, price: 58.2 },
  { ticker: 'AAPL', name: 'Apple Inc.', quantity: 40, price: 255.1 },
  { ticker: 'VMFXX', name: 'Vanguard Federal Money Market', quantity: 6400, price: 1 },
];
const { id: brokerage } = await call('/api/accounts', 'POST', {
  name: 'Vanguard Brokerage (demo)',
  institutionName: 'Vanguard',
  type: 'investment',
  currency: 'USD',
  ownerUserId: null,
});
// A new account: its holdings are at version 0.
await call(`/api/accounts/${brokerage}/holdings`, 'PUT', { holdings, version: 0 });
const priceSeries = holdings.map((holding, index) =>
  holding.ticker === 'VMFXX' ? dates.map(() => 1) : walk(holding.price, holding.ticker === 'VBTLX' ? 0.004 : 0.018, 0.0004, 31 + index),
);
// Its history: the holdings arriving a year ago, priced from a made-up price each month (no market data here).
const months = dates.filter((date, day) => day % 30 === 0 || day === DAYS - 1);
await call('/api/imports', 'POST', {
  accounts: [
    {
      label: 'Demo',
      target: { accountId: brokerage },
      file: {
        kind: 'holdings',
        currency: 'USD',
        asOf: dates.at(-1),
        securities: holdings.map((holding) => ({ id: holding.ticker, ticker: holding.ticker, name: holding.name })),
        positions: holdings.map((holding) => ({ security: holding.ticker, shares: holding.quantity, price: holding.price })),
        cash: 0,
        transactions: holdings.flatMap((holding, index) =>
          months.map((date, month) => {
            const price = Math.round(priceSeries[index][dates.indexOf(date)] * 100) / 100;
            // The first moves the shares in; the rest only carry a price.
            return { date, kind: 'transfer', label: month === 0 ? 'Opening position' : 'Price', security: holding.ticker, shares: month === 0 ? holding.quantity : 0, price, amount: 0, value: 0, charges: 0 };
          }),
        ),
      },
    },
  ],
});

await call('/api/targets', 'PUT', {
  name: 'Target',
  weights: { us_stock: 0.5, intl_stock: 0.2, em_stock: 0.05, au_stock: 0.1, us_bond: 0.1, cash: 0.05 },
  bandPct: 5,
  excludedAccountIds: [],
  excludedCategories: ['real_estate'],
});

console.log(`Seeded demo data for ${email}.`);
