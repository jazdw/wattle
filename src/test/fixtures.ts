/** Realistic API responses for component tests. */
import { emptyCategoryTotals } from '../../shared/allocation';
import type {
  AccountSummary,
  ConnectionsResponse,
  HistoryResponse,
  HoldingRow,
  MeResponse,
  PortfolioResponse,
  QuotesResponse,
  TargetResponse,
} from '../../shared/types';

export const ME: MeResponse = {
  user: { id: 'u-me', name: 'Jared W', email: 'me@example.com', picture: null, householdId: 'h1', role: 'owner' },
  household: {
    id: 'h1',
    name: 'Our household',
    displayCurrency: 'USD',
    members: [
      { id: 'u-me', name: 'Jared W', email: 'me@example.com', picture: null },
      { id: 'u-partner', name: 'Sam P', email: 'sam@example.com', picture: 'https://lh3.googleusercontent.com/sam' },
    ],
  },
};

export function account(overrides: Partial<AccountSummary>): AccountSummary {
  return {
    id: 'a',
    source: 'manual',
    connectionId: null,
    institutionName: null,
    name: 'Account',
    officialName: null,
    mask: null,
    type: 'depository',
    subtype: null,
    currency: 'USD',
    ownerUserId: 'u-me',
    isHidden: false,
    category: null,
    balance: 0,
    balanceAsOf: null,
    missingSince: null,
    displayBalance: 0,
    holdingCount: 0,
    ...overrides,
  };
}

export const ACCOUNTS: AccountSummary[] = [
  account({ id: 'chk', name: 'Chase Checking', institutionName: 'Chase', source: 'plaid', connectionId: 'c-chase', mask: '1234', balance: 8500_00, displayBalance: 8500_00 }),
  account({ id: 'brk', name: 'Vanguard Brokerage', institutionName: 'Vanguard', source: 'plaid', connectionId: 'c-vg', type: 'investment', ownerUserId: null, balance: 250000_00, displayBalance: 250000_00, holdingCount: 3 }),
  account({ id: 'wbc', name: 'Westpac Everyday', institutionName: 'Westpac', currency: 'AUD', balance: 15000_00, displayBalance: 10000_00 }),
  account({ id: 'super', name: 'REST Super', institutionName: 'REST', type: 'investment', currency: 'AUD', category: 'au_stock', ownerUserId: 'u-partner', balance: 150000_00, displayBalance: 100000_00 }),
  account({ id: 'home', name: 'Home', type: 'property', ownerUserId: null, balance: 900000_00, displayBalance: 900000_00 }),
  account({ id: 'card', name: 'Sapphire', institutionName: 'Chase', source: 'plaid', connectionId: 'c-chase', type: 'credit', balance: -2300_00, displayBalance: -2300_00 }),
  account({ id: 'dup', name: 'Joint IRA copy', source: 'plaid', connectionId: 'c-vg', type: 'investment', isHidden: true, balance: null, displayBalance: null }),
  account({ id: 'gone', name: 'Old savings', source: 'plaid', connectionId: 'c-chase', missingSince: 1, balance: null, displayBalance: null }),
];

export const CONNECTIONS: ConnectionsResponse = {
  plaidEnv: 'sandbox',
  itemsUsed: 2,
  connections: [
    { id: 'c-chase', institutionName: 'Chase', kind: 'banking', status: 'ok', errorCode: null, ownerUserId: 'u-me', lastSyncedAt: Date.now() - 3600_000, backfillStatus: 'skipped', consentExpiresAt: null, createdAt: 1 },
    { id: 'c-vg', institutionName: 'Vanguard', kind: 'investments', status: 'login_required', errorCode: 'ITEM_LOGIN_REQUIRED', ownerUserId: 'u-partner', lastSyncedAt: Date.now() - 86400_000, backfillStatus: 'done', consentExpiresAt: null, createdAt: 2 },
  ],
};

function holding(overrides: Partial<HoldingRow>): HoldingRow {
  return {
    securityId: 's',
    ticker: null,
    name: null,
    type: 'etf',
    isPublic: true,
    quantity: 1,
    price: 1,
    value: 100,
    costBasis: null,
    accounts: [{ accountId: 'brk', name: 'Vanguard Brokerage', quantity: 1, value: 100 }],
    classification: { categories: { us_stock: 1 } },
    classificationSource: 'seed',
    needsReview: false,
    ...overrides,
  };
}

export const HOLDINGS: HoldingRow[] = [
  holding({
    securityId: 's-vti', ticker: 'VTI', name: 'Vanguard Total Stock Market ETF', quantity: 500, price: 300, value: 150000_00,
    accounts: [
      { accountId: 'brk', name: 'Vanguard Brokerage', quantity: 400, value: 120000_00 },
      { accountId: 'ira', name: 'Roth IRA', quantity: 100, value: 30000_00 },
    ],
    classification: { categories: { us_stock: 1 }, sizes: { large: 0.72, mid: 0.19, small: 0.09 }, styles: { value: 0.3, blend: 0.32, growth: 0.38 } },
  }),
  holding({
    securityId: 's-vtiax', ticker: 'VTIAX', name: 'Vanguard Total Intl Stock Index Admiral', type: 'mutual fund', quantity: 2000, price: 35, value: 70000_00,
    classification: { categories: { intl_stock: 0.75, em_stock: 0.25 }, sizes: { large: 0.75, mid: 0.17, small: 0.08 }, styles: { value: 0.38, blend: 0.34, growth: 0.28 } },
  }),
  holding({
    securityId: 's-plan', ticker: null, name: 'Insperity 401k Stable Value Trust', type: 'mutual fund', isPublic: false, quantity: 3000, price: 10, value: 30000_00,
    classification: { categories: { cash: 1 } }, classificationSource: 'heuristic', needsReview: true,
  }),
];

export function portfolio(): PortfolioResponse {
  const categories = { ...emptyCategoryTotals(), us_stock: 150000_00, intl_stock: 52500_00, em_stock: 17500_00, au_stock: 100000_00, cash: 48500_00 };
  return {
    currency: 'USD',
    asOf: '2026-10-08',
    netWorth: 1366200_00,
    assets: 1368500_00,
    liabilities: -2300_00,
    categories,
    allCategories: { ...categories, real_estate: 900000_00 },
    holdings: structuredClone(HOLDINGS),
    style: {
      grid: {
        large: { value: 40000_00, blend: 45000_00, growth: 55000_00 },
        mid: { value: 10000_00, blend: 12000_00, growth: 14000_00 },
        small: { value: 5000_00, blend: 6000_00, growth: 7000_00 },
      },
      unclassified: 126000_00,
      equityTotal: 320000_00,
    },
    fxRate: 1.5,
  };
}

export function history(group = 'total'): HistoryResponse {
  const dates = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'];
  const series =
    group === 'total'
      ? [{ key: 'total', label: 'Net worth', values: [1300000_00, 1320000_00, 1350000_00, 1366200_00] }]
      : group === 'holding'
        ? [
            { key: 's-vti', label: 'VTI', values: [140000_00, 145000_00, 148000_00, 150000_00] },
            { key: 's-old', label: 'SOLD', values: [5000_00, 5000_00, 0, 0] },
          ]
        : group === 'category'
          ? [
              { key: 'us_stock', label: 'US stocks', values: [140000_00, 145000_00, 148000_00, 150000_00] },
              { key: 'liabilities', label: 'Liabilities', values: [-2000_00, -2100_00, -2200_00, -2300_00] },
            ]
          : [
              { key: 'brk', label: 'Vanguard Brokerage', values: [240000_00, 245000_00, 248000_00, 250000_00] },
              { key: 'chk', label: 'Chase Checking', values: [8000_00, 8200_00, 8400_00, 8500_00] },
            ];
  return { currency: 'USD', group: group as HistoryResponse['group'], dates, series, estimated: [true, false, false, false] };
}

export const TARGET: TargetResponse = {
  target: {
    id: 't1',
    name: 'Target',
    weights: { us_stock: 0.5, intl_stock: 0.2, em_stock: 0.05, au_stock: 0.1, us_bond: 0.1, cash: 0.05 },
    bandPct: 5,
    excludedAccountIds: [],
    excludedCategories: ['real_estate'],
  },
};

export const QUOTES: QuotesResponse = {
  quotes: [{ ticker: 'VTI', price: 303, change: 3, changePercent: 0.01, previousClose: 300, time: 0 }],
  closes: [{ ticker: 'VTIAX', close: 35.2, date: '2026-10-07' }],
};
