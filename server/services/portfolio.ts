/**
 * Current portfolio: net worth, allocation by category, holdings aggregated
 * across accounts, and the equity style grid — all in one display currency.
 */
import { and, eq } from 'drizzle-orm';
import { categoryTotals, styleBreakdown, type Position } from '../../shared/allocation';
import { marketDate } from '../../shared/dates';
import { convertMinor, currencyName, isCurrency, type Currency, type FxRates } from '../../shared/money';
import type { Category, Classification } from '../../shared/taxonomy';
import type { BalanceRow, HoldingRow, PortfolioResponse } from '../../shared/types';
import { accounts, holdings, securities, targets } from '../db/schema';
import type { Tenant } from '../db/tenant';
import type { Deps } from '../ports';
import { closeLookup, fxLookup } from './pricing';
import { isCashSecurity } from './valuation';

const LIABILITY_TYPES = new Set(['credit', 'loan']);

const cashKey = (code: string) => `cash:${code}`;

/** A currency's cash row when no investment account holds that cash, only bank accounts. */
function cashRow(code: Currency): HoldingRow {
  return {
    securityId: cashKey(code),
    ticker: code,
    cusip: null,
    isin: null,
    name: `${currencyName(code)} (cash)`,
    type: 'cash',
    typeEditable: false,
    classifiable: false,
    isPublic: false,
    currency: code,
    quantity: 0,
    price: 1,
    value: 0,
    costBasis: null,
    accounts: [],
    classification: { categories: { cash: 1 } },
    classificationSource: null,
    needsReview: false,
  };
}

export function defaultCategory(type: string): Category {
  if (type === 'depository') return 'cash';
  if (type === 'property') return 'real_estate';
  return 'other';
}

export function toCurrency(value: string): Currency {
  return isCurrency(value) ? value : 'USD';
}

export async function activeTarget(tenant: Tenant) {
  const [target] = await tenant.db
    .select()
    .from(targets)
    .where(tenant.scope(targets, eq(targets.isActive, true)))
    .limit(1);
  return target ?? null;
}

export async function loadPortfolio(deps: Deps, tenant: Tenant, currency: Currency): Promise<PortfolioResponse> {
  const today = marketDate(deps.now());
  const rates: FxRates = (await fxLookup(deps, today, today))(today);
  const convert = (minor: number, from: string) => convertMinor(minor, toCurrency(from), currency, rates);

  const accountRows = await tenant.db
    .select()
    .from(accounts)
    .where(tenant.scope(accounts, eq(accounts.isHidden, false)));
  const accountById = new Map(accountRows.map((account) => [account.id, account]));

  const holdingRows = await tenant.db
    .select({
      accountId: holdings.accountId,
      securityId: holdings.securityId,
      quantity: holdings.quantity,
      price: holdings.price,
      value: holdings.value,
      costBasis: holdings.costBasis,
      currency: holdings.currency,
      ticker: securities.ticker,
      cusip: securities.cusip,
      isin: securities.isin,
      name: securities.name,
      type: securities.type,
      externalId: securities.externalId,
      isPublic: securities.isPublic,
      classification: securities.classification,
      classificationSource: securities.classificationSource,
      needsReview: securities.needsReview,
    })
    .from(holdings)
    .innerJoin(securities, and(eq(securities.id, holdings.securityId), eq(securities.householdId, holdings.householdId)))
    .where(tenant.scope(holdings));

  // Value public securities at the latest stored close so manual holdings
  // stay current; fall back to the institution's value.
  const tickers = holdingRows.filter((row) => row.isPublic && row.ticker).map((row) => row.ticker!);
  const closes = await closeLookup(deps, tickers, today, today);

  const target = await activeTarget(tenant);
  const excludedAccounts = new Set(target?.excludedAccountIds ?? []);
  const excludedCategories = new Set(target?.excludedCategories ?? []);

  const allPositions: Position[] = [];
  const scopedPositions: Position[] = [];
  const addPosition = (accountId: string, valueMinor: number, classification: Classification) => {
    const position = { valueMinor, classification };
    allPositions.push(position);
    if (!excludedAccounts.has(accountId)) scopedPositions.push(position);
  };

  const byAccountTotal = new Map<string, number>();
  const aggregated = new Map<string, HoldingRow>();
  for (const row of holdingRows) {
    const account = accountById.get(row.accountId);
    if (!account) continue;
    const close = row.isPublic && row.ticker ? closes(row.ticker, today) : null;
    const native = close !== null ? Math.round(row.quantity * close * 100) : row.value;
    const value = convert(native, row.currency);
    byAccountTotal.set(row.accountId, (byAccountTotal.get(row.accountId) ?? 0) + value);
    const classification = row.classification ?? { categories: { other: 1 } };
    addPosition(row.accountId, value, classification);

    // Cash positions: institutions name them inconsistently (Plaid: "U S
    // Dollar", no ticker), so show the ISO 4217 code and its name instead,
    // for any currency. Plaid's CUR:XXX ticker names the currency when given.
    // One row per currency for cash, whichever security an institution uses.
    const cashCode = isCashSecurity(row) ? (row.ticker?.startsWith('CUR:') ? row.ticker.slice(4) : row.currency).toUpperCase() : null;
    const key = cashCode ? cashKey(cashCode) : row.securityId;
    const entry = aggregated.get(key) ?? {
      securityId: row.securityId,
      ticker: cashCode ?? row.ticker,
      cusip: row.cusip,
      isin: row.isin,
      name: cashCode ? `${currencyName(cashCode)} (cash)` : row.name,
      type: row.type,
      typeEditable: row.externalId === null,
      classifiable: cashCode === null,
      isPublic: row.isPublic,
      currency: toCurrency(row.currency),
      quantity: 0,
      price: close ?? row.price,
      value: 0,
      costBasis: null,
      accounts: [],
      classification,
      classificationSource: row.classificationSource,
      needsReview: row.needsReview,
    };
    entry.quantity += row.quantity;
    entry.value += value;
    if (row.costBasis !== null) entry.costBasis = (entry.costBasis ?? 0) + convert(row.costBasis, row.currency);
    entry.accounts.push({ accountId: row.accountId, name: account.name, quantity: row.quantity, value });
    aggregated.set(key, entry);
  }

  let assets = 0;
  let liabilities = 0;
  const balances: BalanceRow[] = [];
  for (const account of accountRows) {
    const fromHoldings = byAccountTotal.get(account.id);
    const value = fromHoldings ?? (account.balance !== null ? convert(account.balance, account.currency) : 0);
    if (LIABILITY_TYPES.has(account.type) || value < 0) {
      liabilities += value;
      continue;
    }
    assets += value;
    if (fromHoldings === undefined && value !== 0) {
      const category = (account.category as Category | null) ?? defaultCategory(account.type);
      addPosition(account.id, value, { categories: { [category]: 1 } });
      if (category === 'cash' && account.balance !== null) {
        // Cash in a bank account joins its currency's cash row, beside cash held in investment accounts.
        const code = toCurrency(account.currency);
        const entry = aggregated.get(cashKey(code)) ?? cashRow(code);
        entry.quantity += account.balance / 100;
        entry.value += value;
        entry.accounts.push({ accountId: account.id, name: account.name, quantity: account.balance / 100, value });
        aggregated.set(cashKey(code), entry);
      } else {
        balances.push({ accountId: account.id, name: account.name, type: account.type, subtype: account.subtype, category, value });
      }
    }
  }

  const scoped = categoryTotals(scopedPositions);
  for (const category of excludedCategories) scoped[category as Category] = 0;

  const usdAud = rates['USD->AUD'] ?? null;
  return {
    currency,
    asOf: today,
    netWorth: assets + liabilities,
    assets,
    liabilities,
    categories: scoped,
    allCategories: categoryTotals(allPositions),
    holdings: [...aggregated.values()].sort((a, b) => b.value - a.value),
    balances: balances.sort((a, b) => b.value - a.value),
    style: styleBreakdown(scopedPositions),
    fxRate: usdAud,
  };
}
