/**
 * Daily history series for the growth chart: total, per account, per
 * allocation category, or per holding within one account. Missing days are
 * carried forward from the last known value; values are converted to the
 * display currency at each day's FX rate.
 */
import { and, eq, gte, inArray, lte, min } from 'drizzle-orm';
import { normalizeWeights, CATEGORY_LABELS, type Category, type Classification } from '../../shared/taxonomy';
import { addDays, dateRange, marketDate, type IsoDate } from '../../shared/dates';
import { convertMinor, type Currency } from '../../shared/money';
import type { HistoryGroup, HistoryResponse, HistorySeries } from '../../shared/types';
import { accountDaily, accounts, holdingDaily, securities } from '../db/schema';
import type { Tenant } from '../db/tenant';
import type { Deps } from '../ports';
import { defaultCategory, toCurrency } from './portfolio';
import { fxLookup } from './pricing';

export const RANGES = ['1M', '3M', '6M', 'YTD', '1Y', '2Y', 'ALL'] as const;
export type Range = (typeof RANGES)[number];

/** Days before the range start to look back for a value to carry forward. */
const CARRY_DAYS = 31;

export async function rangeStart(tenant: Tenant, range: Range, end: IsoDate): Promise<IsoDate> {
  switch (range) {
    case '1M':
      return addDays(end, -30);
    case '3M':
      return addDays(end, -91);
    case '6M':
      return addDays(end, -182);
    case 'YTD':
      return `${end.slice(0, 4)}-01-01`;
    case '1Y':
      return addDays(end, -365);
    case '2Y':
      return addDays(end, -730);
    case 'ALL': {
      const [row] = await tenant.db
        .select({ first: min(accountDaily.date) })
        .from(accountDaily)
        .where(tenant.scope(accountDaily));
      return row?.first ?? addDays(end, -30);
    }
  }
}

interface Options {
  range: Range;
  group: HistoryGroup;
  currency: Currency;
  accountId?: string;
}

export async function loadHistory(deps: Deps, tenant: Tenant, options: Options): Promise<HistoryResponse> {
  const end = marketDate(deps.now());
  const start = await rangeStart(tenant, options.range, end);
  const dates = dateRange(start, end);
  const fx = await fxLookup(deps, start, end);
  const convert = (minor: number, from: string, date: IsoDate) =>
    convertMinor(minor, toCurrency(from), options.currency, fx(date));

  const accountRows = await tenant.db
    .select()
    .from(accounts)
    .where(
      tenant.scope(
        accounts,
        eq(accounts.isHidden, false),
        options.accountId ? eq(accounts.id, options.accountId) : undefined,
      ),
    );
  const accountIds = accountRows.map((account) => account.id);
  const empty: HistoryResponse = { currency: options.currency, group: options.group, dates, series: [], estimated: dates.map(() => false) };
  if (accountIds.length === 0) return empty;

  const balanceRows = await tenant.db
    .select()
    .from(accountDaily)
    .where(
      tenant.scope(
        accountDaily,
        inArray(accountDaily.accountId, accountIds),
        gte(accountDaily.date, addDays(start, -CARRY_DAYS)),
        lte(accountDaily.date, end),
      ),
    )
    .orderBy(accountDaily.date);

  const estimated = dates.map(() => false);
  const index = new Map(dates.map((date, position) => [date, position]));

  // Per account: carried-forward display-currency value for each date.
  const perAccount = new Map<string, (number | null)[]>();
  for (const account of accountRows) {
    const rows = balanceRows.filter((row) => row.accountId === account.id);
    const values: (number | null)[] = [];
    let cursor = 0;
    let last: (typeof rows)[number] | null = null;
    for (const [position, date] of dates.entries()) {
      while (cursor < rows.length && rows[cursor].date <= date) last = rows[cursor++];
      values.push(last ? convert(last.balance, last.currency, date) : null);
      if (last?.estimated && last.date === date) estimated[position] = true;
    }
    perAccount.set(account.id, values);
  }

  const sum = (lists: (number | null)[][]) =>
    dates.map((_, position) => {
      let total: number | null = null;
      for (const list of lists) if (list[position] !== null) total = (total ?? 0) + list[position]!;
      return total;
    });

  let series: HistorySeries[];
  switch (options.group) {
    case 'total':
      series = [{ key: 'total', label: 'Net worth', values: sum([...perAccount.values()]) }];
      break;
    case 'account':
      series = accountRows.map((account) => ({
        key: account.id,
        label: account.name,
        values: perAccount.get(account.id)!,
      }));
      break;
    case 'category':
      series = await categorySeries(tenant, accountRows, perAccount, dates, start, end, convert);
      break;
    case 'holding':
      series = await holdingSeries(tenant, accountIds, dates, start, end, convert, estimated, index);
      break;
  }

  return { currency: options.currency, group: options.group, dates, series: series.filter((s) => s.values.some((value) => value !== null && value !== 0)), estimated };
}

type Convert = (minor: number, from: string, date: IsoDate) => number;

async function holdingSeries(
  tenant: Tenant,
  accountIds: string[],
  dates: IsoDate[],
  start: IsoDate,
  end: IsoDate,
  convert: Convert,
  estimated: boolean[],
  index: Map<IsoDate, number>,
): Promise<HistorySeries[]> {
  const rows = await tenant.db
    .select({
      securityId: holdingDaily.securityId,
      date: holdingDaily.date,
      value: holdingDaily.value,
      currency: holdingDaily.currency,
      estimated: holdingDaily.estimated,
      ticker: securities.ticker,
      name: securities.name,
    })
    .from(holdingDaily)
    .innerJoin(securities, and(eq(securities.id, holdingDaily.securityId), eq(securities.householdId, holdingDaily.householdId)))
    .where(
      tenant.scope(
        holdingDaily,
        inArray(holdingDaily.accountId, accountIds),
        gte(holdingDaily.date, start),
        lte(holdingDaily.date, end),
      ),
    );
  const bySecurity = new Map<string, HistorySeries>();
  for (const row of rows) {
    const position = index.get(row.date);
    if (position === undefined) continue;
    let entry = bySecurity.get(row.securityId);
    if (!entry) {
      entry = { key: row.securityId, label: row.ticker ?? row.name ?? 'Unknown', values: dates.map(() => null) };
      bySecurity.set(row.securityId, entry);
    }
    entry.values[position] = (entry.values[position] ?? 0) + convert(row.value, row.currency, row.date);
    if (row.estimated) estimated[position] = true;
  }
  return [...bySecurity.values()].sort((a, b) => (b.values.at(-1) ?? 0) - (a.values.at(-1) ?? 0));
}

async function categorySeries(
  tenant: Tenant,
  accountRows: (typeof accounts.$inferSelect)[],
  perAccount: Map<string, (number | null)[]>,
  dates: IsoDate[],
  start: IsoDate,
  end: IsoDate,
  convert: Convert,
): Promise<HistorySeries[]> {
  const index = new Map(dates.map((date, position) => [date, position]));
  const totals = new Map<string, number[]>();
  const add = (key: string, position: number, value: number) => {
    const list = totals.get(key) ?? dates.map(() => 0);
    list[position] += value;
    totals.set(key, list);
  };

  const rows = await tenant.db
    .select({
      accountId: holdingDaily.accountId,
      date: holdingDaily.date,
      value: holdingDaily.value,
      currency: holdingDaily.currency,
      classification: securities.classification,
    })
    .from(holdingDaily)
    .innerJoin(securities, and(eq(securities.id, holdingDaily.securityId), eq(securities.householdId, holdingDaily.householdId)))
    .where(
      tenant.scope(
        holdingDaily,
        inArray(
          holdingDaily.accountId,
          accountRows.map((account) => account.id),
        ),
        gte(holdingDaily.date, start),
        lte(holdingDaily.date, end),
      ),
    );

  // Account/day pairs covered by holdings; other days use the account balance.
  const covered = new Set<string>();
  for (const row of rows) {
    const position = index.get(row.date);
    if (position === undefined) continue;
    covered.add(`${row.accountId}:${row.date}`);
    const weights = normalizeWeights((row.classification as Classification | null)?.categories ?? { other: 1 });
    const value = convert(row.value, row.currency, row.date);
    for (const [category, weight] of Object.entries(weights)) add(category, position, value * (weight ?? 0));
  }

  for (const account of accountRows) {
    const values = perAccount.get(account.id)!;
    const liability = account.type === 'credit' || account.type === 'loan';
    const category = liability ? 'liabilities' : ((account.category as Category | null) ?? defaultCategory(account.type));
    for (const [position, date] of dates.entries()) {
      if (values[position] === null || covered.has(`${account.id}:${date}`)) continue;
      add(category, position, values[position]!);
    }
  }

  return [...totals.entries()].map(([key, values]) => ({
    key,
    label: key === 'liabilities' ? 'Liabilities' : CATEGORY_LABELS[key as Category],
    values: values.map((value) => Math.round(value)),
  }));
}
