/**
 * Daily history series for the growth chart: total, per account, per
 * allocation category, or per holding within one account. Missing days are
 * carried forward from the last known value; values are converted to the
 * display currency at each day's FX rate. Each value comes with its quality
 * (shared/quality.ts): where it came from, combined over its parts.
 */
import { and, eq, gte, inArray, lte, min } from 'drizzle-orm';
import { holdingLabel, holdingParts, type NamedSecurity } from '../../shared/holdings';
import { normalizeWeights, CATEGORY_LABELS, type Category, type Classification } from '../../shared/taxonomy';
import { addDays, dateRange, marketDate, type IsoDate } from '../../shared/dates';
import { convertMinor, type Currency } from '../../shared/money';
import { dayQuality, type DailySource, type PriceSource, type Quality } from '../../shared/quality';
import { fixedRangeStart, type Range } from '../../shared/ranges';
import type { HistoryGroup, HistoryResponse, HistorySeries } from '../../shared/types';
import { inChunks } from '../db/batch';
import { accountDaily, accounts, holdingDaily, securities } from '../db/schema';
import type { Tenant } from '../db/tenant';
import type { Deps } from '../ports';
import { accountLabel } from '../../shared/accounts';
import { breakdown } from './breakdown';
import { inTransit, inTransitByAccount, linkedTransfers } from './transfers';
import { defaultCategory, toCurrency } from './portfolio';
import { fxLookup } from './pricing';

export { RANGES } from '../../shared/ranges';
export type { Range };

/** Days before the range start to look back for a value to carry forward. */
const CARRY_DAYS = 31;

export async function rangeStart(tenant: Tenant, range: Range, end: IsoDate): Promise<IsoDate> {
  const fixed = fixedRangeStart(range, end);
  if (fixed) return fixed;
  const [row] = await tenant.db
    .select({ first: min(accountDaily.date) })
    .from(accountDaily)
    .where(tenant.scope(accountDaily));
  return row?.first ?? addDays(end, -30);
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
  const empty: HistoryResponse = { currency: options.currency, group: options.group, dates, series: [] };
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

  const index = new Map(dates.map((date, position) => [date, position]));

  // Per account: carried-forward display-currency value for each date.
  //
  // A linked account with no history before some date (a loan, which Plaid's
  // balance history doesn't cover; accounts at an investment login other
  // than the investment ones) would otherwise appear from nowhere on that day
  // and make the total lurch. Its first known balance is carried back
  // instead, and those days are marked carried. Manual accounts aren't:
  // their first entry is a date you chose.
  // Each account's first stored day overall (the rows above start just
  // before the range, so they can't tell "no history" from a gap).
  const firstDays = new Map<string, IsoDate>();
  for (const chunk of inChunks(accountIds)) {
    const rows = await tenant.db
      .select({ accountId: accountDaily.accountId, first: min(accountDaily.date) })
      .from(accountDaily)
      .where(tenant.scope(accountDaily, inArray(accountDaily.accountId, chunk)))
      .groupBy(accountDaily.accountId);
    for (const row of rows) if (row.first) firstDays.set(row.accountId, row.first);
  }
  const perAccount = new Map<string, (number | null)[]>();
  const perAccountQuality = new Map<string, (Quality | null)[]>();
  for (const account of accountRows) {
    const rows = balanceRows.filter((row) => row.accountId === account.id);
    const firstDay = firstDays.get(account.id);
    // Only if its history starts inside the range (then it's in `rows`).
    const first = account.source === 'plaid' && firstDay ? rows.find((row) => row.date === firstDay) : undefined;
    // No longer reported (closed, or deselected in Plaid): out of totals from that day on, as it is from today's.
    const gone = account.missingSince !== null ? marketDate(new Date(account.missingSince)) : null;
    const values: (number | null)[] = [];
    const quality: (Quality | null)[] = [];
    let cursor = 0;
    let last: (typeof rows)[number] | null = null;
    for (const date of dates) {
      while (cursor < rows.length && rows[cursor].date <= date) last = rows[cursor++];
      if (gone && date >= gone) {
        values.push(null);
        quality.push(null);
        continue;
      }
      if (!last && first && date < first.date) {
        values.push(convert(first.balance, first.currency, date));
        quality.push(carriedFrom(first));
        continue;
      }
      values.push(last ? convert(last.balance, last.currency, date) : null);
      quality.push(!last ? null : last.date === date ? qualityOf(last) : carriedFrom(last));
    }
    perAccount.set(account.id, values);
    perAccountQuality.set(account.id, quality);
  }

  const sum = (lists: (number | null)[][]) =>
    dates.map((_, position) => {
      let total: number | null = null;
      for (const list of lists) if (list[position] !== null) total = (total ?? 0) + list[position]!;
      return total;
    });

  // The household's transfers between its accounts: counted on one date, not in both accounts (or neither) while in transit.
  const linked = options.accountId ? [] : await linkedTransfers(tenant);
  const transit = inTransit(dates, linked, convert);
  const withTransit = (values: (number | null)[], adjustment = transit) =>
    values.map((value, position) => (value === null ? (adjustment[position] ? adjustment[position] : null) : value + adjustment[position]));
  const transitByAccount = inTransitByAccount(dates, linked, convert);
  const none = dates.map(() => null);

  let series: HistorySeries[];
  switch (options.group) {
    case 'total':
      series = [{ key: 'total', label: 'Net worth', values: withTransit(sum([...perAccount.values()])), quality: combined(dates, [...perAccountQuality.values()]) }];
      break;
    case 'account':
      series = accountRows.map((account) => ({
        key: account.id,
        label: accountLabel(account),
        // Money between two of them shown in one, on one date (it'd be in both, or neither, for a day or two).
        values: transitByAccount.has(account.id) ? withTransit(perAccount.get(account.id)!, transitByAccount.get(account.id)) : perAccount.get(account.id)!,
        quality: perAccountQuality.get(account.id)!,
      }));
      break;
    case 'category': {
      series = await categorySeries(tenant, accountRows, perAccount, perAccountQuality, dates, start, end, convert);
      // Money in transit is cash.
      if (transit.some((value) => value !== 0)) {
        const cash = series.find((entry) => entry.key === 'cash');
        if (cash) cash.values = withTransit(cash.values);
        else series.push({ key: 'cash', label: CATEGORY_LABELS.cash, values: transit, quality: none });
      }
      break;
    }
    case 'holding':
      series = await holdingSeries(tenant, accountIds, dates, start, end, convert, index);
      break;
    case 'source': {
      // Every part, even one that's nothing throughout: the page combines them.
      const internal = new Set(linked.flatMap((pair) => [pair.out.id, pair.in.id]));
      const found = await breakdown(tenant, { dates, accounts: accountRows, values: perAccount, convert, household: !options.accountId, internal, transit });
      return { currency: options.currency, group: options.group, dates, series: found.series, breakdown: found.rows };
    }
  }

  return { currency: options.currency, group: options.group, dates, series: series.filter((s) => s.values.some((value) => value !== null && value !== 0)) };
}

type QualityRow = { source: DailySource; priceSource: PriceSource | null; unmatched: boolean };
/** A holding's labels as a series has them: long, short (the legend) and the second line under the short (the table). */
function holdingSeriesLabels(security: NamedSecurity): Pick<HistorySeries, 'label' | 'shortLabel' | 'detail'> {
  const { short, detail } = holdingParts(security);
  return { label: holdingLabel(security), shortLabel: short, ...(detail ? { detail } : {}) };
}

const qualityOf = (row: QualityRow): Quality => ({ source: row.source, priceSource: row.priceSource, unmatched: row.unmatched });
/** A stored value shown on a day it isn't for. */
const carriedFrom = (row: QualityRow): Quality => ({ ...qualityOf(row), source: 'carried' });

/** Per date, the combined quality of the values in several lists. */
function combined(dates: IsoDate[], lists: (Quality | null)[][]): (Quality | null)[] {
  return dates.map((_, position) => dayQuality(lists.flatMap((list) => (list[position] ? [list[position]] : []))));
}

type Convert = (minor: number, from: string, date: IsoDate) => number;

async function holdingSeries(
  tenant: Tenant,
  accountIds: string[],
  dates: IsoDate[],
  start: IsoDate,
  end: IsoDate,
  convert: Convert,
  index: Map<IsoDate, number>,
): Promise<HistorySeries[]> {
  const rows = await tenant.db
    .select({
      securityId: holdingDaily.securityId,
      date: holdingDaily.date,
      value: holdingDaily.value,
      currency: holdingDaily.currency,
      source: holdingDaily.source,
      priceSource: holdingDaily.priceSource,
      unmatched: holdingDaily.unmatched,
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
  const parts = new Map<string, Quality[][]>();
  // Days with any holding row: a security absent on such a day was not held
  // (e.g. sold), so it reads as zero rather than a gap.
  const covered = new Set<number>();
  for (const row of rows) {
    const position = index.get(row.date);
    if (position !== undefined) covered.add(position);
  }
  for (const row of rows) {
    const position = index.get(row.date);
    if (position === undefined) continue;
    let entry = bySecurity.get(row.securityId);
    if (!entry) {
      entry = { key: row.securityId, ...holdingSeriesLabels(row), values: dates.map(() => null), quality: dates.map(() => null) };
      bySecurity.set(row.securityId, entry);
      parts.set(row.securityId, dates.map(() => []));
    }
    entry.values[position] = (entry.values[position] ?? 0) + convert(row.value, row.currency, row.date);
    parts.get(row.securityId)![position].push(qualityOf(row));
  }
  for (const series of bySecurity.values()) {
    series.quality = parts.get(series.key)!.map(dayQuality);
    // Not held that day: zero, with no quality of its own.
    for (const position of covered) series.values[position] ??= 0;
  }
  return [...bySecurity.values()].sort((a, b) => (b.values.at(-1) ?? 0) - (a.values.at(-1) ?? 0));
}

async function categorySeries(
  tenant: Tenant,
  accountRows: (typeof accounts.$inferSelect)[],
  perAccount: Map<string, (number | null)[]>,
  perAccountQuality: Map<string, (Quality | null)[]>,
  dates: IsoDate[],
  start: IsoDate,
  end: IsoDate,
  convert: Convert,
): Promise<HistorySeries[]> {
  const index = new Map(dates.map((date, position) => [date, position]));
  const totals = new Map<string, number[]>();
  const parts = new Map<string, Quality[][]>();
  const add = (key: string, position: number, value: number, quality: Quality | null) => {
    const list = totals.get(key) ?? dates.map(() => 0);
    list[position] += value;
    totals.set(key, list);
    const qualities = parts.get(key) ?? dates.map(() => []);
    if (quality) qualities[position].push(quality);
    parts.set(key, qualities);
  };

  const rows = await tenant.db
    .select({
      accountId: holdingDaily.accountId,
      date: holdingDaily.date,
      value: holdingDaily.value,
      currency: holdingDaily.currency,
      classification: securities.classification,
      source: holdingDaily.source,
      priceSource: holdingDaily.priceSource,
      unmatched: holdingDaily.unmatched,
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

  // Account/day pairs covered by holdings, and each one's value by category; other days use the account balance.
  const covered = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const position = index.get(row.date);
    if (position === undefined) continue;
    const split = covered.get(`${row.accountId}:${row.date}`) ?? new Map<string, number>();
    covered.set(`${row.accountId}:${row.date}`, split);
    const weights = normalizeWeights((row.classification as Classification | null)?.categories ?? { other: 1 });
    const value = convert(row.value, row.currency, row.date);
    for (const [category, weight] of Object.entries(weights)) {
      add(category, position, value * (weight ?? 0), qualityOf(row));
      split.set(category, (split.get(category) ?? 0) + value * (weight ?? 0));
    }
  }

  for (const account of accountRows) {
    const values = perAccount.get(account.id)!;
    const quality = perAccountQuality.get(account.id)!;
    const liability = account.type === 'credit' || account.type === 'loan';
    const category = liability ? 'liabilities' : ((account.category as Category | null) ?? defaultCategory(account.type));
    // A day without holdings (a missed sync) carries the last day's split, as its balance is carried.
    let last: Map<string, number> | null = null;
    for (const [position, date] of dates.entries()) {
      const split = covered.get(`${account.id}:${date}`);
      if (split) {
        last = split;
        continue;
      }
      if (values[position] === null) continue;
      const lastTotal = last ? [...last.values()].reduce((sum, value) => sum + value, 0) : 0;
      if (last && lastTotal !== 0) {
        for (const [key, value] of last) add(key, position, (values[position]! * value) / lastTotal, quality[position]);
      } else add(category, position, values[position]!, quality[position]);
    }
  }

  return [...totals.entries()].map(([key, values]) => ({
    key,
    label: key === 'liabilities' ? 'Liabilities' : CATEGORY_LABELS[key as Category],
    values: values.map((value) => Math.round(value)),
    quality: parts.get(key)!.map(dayQuality),
  }));
}
