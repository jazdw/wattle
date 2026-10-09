/**
 * Current portfolio: net worth, allocation by category, holdings aggregated
 * across accounts, and the equity style grid — all in one display currency.
 */
import { and, eq } from 'drizzle-orm';
import { categoryTotals, styleBreakdown, type Position } from '../../shared/allocation';
import { marketDate } from '../../shared/dates';
import { convertMinor, isCurrency, type Currency, type FxRates } from '../../shared/money';
import type { Category, Classification } from '../../shared/taxonomy';
import type { HoldingRow, PortfolioResponse } from '../../shared/types';
import { accounts, holdings, securities, targets } from '../db/schema';
import type { Tenant } from '../db/tenant';
import type { Deps } from '../ports';
import { closeLookup, fxLookup } from './pricing';

const LIABILITY_TYPES = new Set(['credit', 'loan']);

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
      name: securities.name,
      type: securities.type,
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

    const entry = aggregated.get(row.securityId) ?? {
      securityId: row.securityId,
      ticker: row.ticker,
      name: row.name,
      type: row.type,
      isPublic: row.isPublic,
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
    aggregated.set(row.securityId, entry);
  }

  let assets = 0;
  let liabilities = 0;
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
    style: styleBreakdown(scopedPositions),
    fxRate: usdAud,
  };
}
