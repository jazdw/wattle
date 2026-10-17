/**
 * End-of-day prices and FX rates, cached in prices_daily / fx_daily (public
 * reference data shared by all households). Lookups carry the last known
 * value forward over weekends and holidays.
 */
import { and, desc, eq, gte, inArray, lte, max, min, sql } from 'drizzle-orm';
import { addDays, lastTradingDay, type IsoDate } from '../../shared/dates';
import type { Currency, FxRates } from '../../shared/money';
import { chunkRows, inChunks, runBatch } from '../db/batch';
import { fxDaily, pricesDaily } from '../db/schema';
import type { DailyClose, Deps } from '../ports';
import { cacheGet, cacheGetMany, cacheSet, cacheSetMany } from './cache';

/** Look back this far for the last close before a range starts. */
const CARRY_DAYS = 10;
/** How long to remember that the provider doesn't know a ticker. */
const UNKNOWN_TTL_SECONDS = 7 * 24 * 3600;

type PriceRow = typeof pricesDaily.$inferInsert;

const unknownKey = (ticker: string) => `noprice:${ticker}`;

function normalise(tickers: string[]): string[] {
  return [...new Set(tickers.map((ticker) => ticker.toUpperCase()))];
}

/** First and last stored close per ticker. */
async function coverage(deps: Deps, tickers: string[]) {
  const byTicker = new Map<string, { first: IsoDate | null; last: IsoDate | null }>();
  for (const chunk of inChunks(tickers)) {
    const rows = await deps.db
      .select({ ticker: pricesDaily.ticker, first: min(pricesDaily.date), last: max(pricesDaily.date) })
      .from(pricesDaily)
      .where(inArray(pricesDaily.ticker, chunk))
      .groupBy(pricesDaily.ticker);
    for (const row of rows) byTicker.set(row.ticker, { first: row.first, last: row.last });
  }
  return byTicker;
}

/** Tickers the provider recently said it doesn't know (one query). */
async function knownUnknowns(deps: Deps, tickers: string[]): Promise<Set<string>> {
  const found = await cacheGetMany<boolean>(deps, tickers.map(unknownKey));
  return new Set(tickers.filter((ticker) => found.has(unknownKey(ticker))));
}

/** Store closes; a later source (Tiingo) replaces an earlier one (Plaid) for the same day. */
export async function saveCloses(deps: Deps, rows: PriceRow[], options: { replace: boolean }): Promise<void> {
  if (rows.length === 0) return;
  await runBatch(
    deps.db,
    chunkRows(pricesDaily, rows).map((chunk) => {
      const insert = deps.db.insert(pricesDaily).values(chunk);
      return options.replace
        ? insert.onConflictDoUpdate({
            target: [pricesDaily.ticker, pricesDaily.date],
            set: { close: sql`excluded.close`, source: sql`excluded.source` },
          })
        : insert.onConflictDoNothing();
    }),
  );
}

/**
 * Make sure each ticker has its latest close as of `date` (the nightly
 * snapshot, manual holdings). Prices Plaid already supplied count. What's
 * missing is fetched in bulk where the provider can (Tiingo's IEX endpoint for
 * stocks and ETFs), then one request per remaining ticker (mutual funds).
 */
export async function ensureRecentCloses(deps: Deps, tickers: string[], date: IsoDate): Promise<void> {
  if (!deps.prices || tickers.length === 0) return;
  const expected = lastTradingDay(date);
  const unique = normalise(tickers);
  const have = await coverage(deps, unique);
  const unknown = await knownUnknowns(deps, unique);
  const stale = unique.filter((ticker) => !unknown.has(ticker) && !((have.get(ticker)?.last ?? '') >= expected));
  if (stale.length === 0) return;

  const rows: PriceRow[] = [];
  let bulk = new Map<string, DailyClose>();
  if (deps.prices.latestCloses) {
    try {
      bulk = await deps.prices.latestCloses(stale);
    } catch (error) {
      console.warn('Bulk price fetch failed', error instanceof Error ? error.message : error);
    }
  }
  for (const [ticker, close] of bulk) rows.push({ ticker, date: close.date, close: close.close, currency: 'USD', source: 'tiingo' });

  const newlyUnknown: string[] = [];
  for (const ticker of stale) {
    const last = have.get(ticker)?.last ?? null;
    const fromBulk = bulk.get(ticker);
    if (fromBulk && fromBulk.date >= expected) continue;
    // Mutual fund NAVs publish after midnight New York, so the nightly run
    // usually sees yesterday's. One trading day behind is fine: the next run
    // fills it in.
    if (last && last >= lastTradingDay(addDays(expected, -1)) && !fromBulk) continue;
    let closes: DailyClose[];
    try {
      closes = await deps.prices.dailyCloses(ticker, last ? addDays(last, 1) : addDays(date, -7), date);
    } catch (error) {
      console.warn('Price fetch failed', ticker, error instanceof Error ? error.message : error);
      continue;
    }
    if (closes.length === 0 && !last && !fromBulk) newlyUnknown.push(ticker);
    for (const close of closes) rows.push({ ticker, date: close.date, close: close.close, currency: 'USD', source: 'tiingo' });
  }
  await saveCloses(deps, rows, { replace: true });
  await cacheSetMany(deps, newlyUnknown.map((ticker) => [unknownKey(ticker), true]), UNKNOWN_TTL_SECONDS);
}

/**
 * Make sure prices_daily covers [start, end] for each ticker (history
 * backfill), fetching only the missing edges. There's no bulk history
 * endpoint, so this is one request per ticker that needs it.
 */
export async function ensureCloses(deps: Deps, tickers: string[], start: IsoDate, end: IsoDate): Promise<void> {
  if (!deps.prices || tickers.length === 0) return;
  const unique = normalise(tickers);
  const have = await coverage(deps, unique);
  const unknown = await knownUnknowns(deps, unique);
  const rows: PriceRow[] = [];
  const newlyUnknown: string[] = [];

  for (const ticker of unique) {
    if (unknown.has(ticker)) continue;
    const stored = have.get(ticker);
    const ranges: [IsoDate, IsoDate][] = [];
    if (!stored?.first || !stored.last) {
      ranges.push([start, end]);
    } else {
      // Small gaps at the edges (weekends) are expected; refetch only when
      // the stored range falls short by more than a long weekend.
      if (stored.first > addDays(start, 4)) ranges.push([start, addDays(stored.first, -1)]);
      if (stored.last < lastTradingDay(end)) ranges.push([addDays(stored.last, 1), end]);
    }
    for (const [from, to] of ranges) {
      if (from > to) continue;
      let closes: DailyClose[];
      try {
        closes = await deps.prices.dailyCloses(ticker, from, to);
      } catch (error) {
        console.warn('Price fetch failed', ticker, error instanceof Error ? error.message : error);
        continue;
      }
      if (closes.length === 0 && !stored) {
        newlyUnknown.push(ticker);
        break;
      }
      for (const close of closes) rows.push({ ticker, date: close.date, close: close.close, currency: 'USD', source: 'tiingo' });
    }
  }
  await saveCloses(deps, rows, { replace: true });
  await cacheSetMany(deps, newlyUnknown.map((ticker) => [unknownKey(ticker), true]), UNKNOWN_TTL_SECONDS);
}

export type CloseLookup = (ticker: string, date: IsoDate) => number | null;

/** As-of close lookup over [start, end] for the given tickers. */
export async function closeLookup(deps: Deps, tickers: string[], start: IsoDate, end: IsoDate): Promise<CloseLookup> {
  const unique = [...new Set(tickers.map((ticker) => ticker.toUpperCase()))];
  const series = new Map<string, { date: IsoDate; close: number }[]>();
  for (const chunk of inChunks(unique)) {
    const rows = await deps.db
      .select({ ticker: pricesDaily.ticker, date: pricesDaily.date, close: pricesDaily.close })
      .from(pricesDaily)
      .where(
        and(
          inArray(pricesDaily.ticker, chunk),
          gte(pricesDaily.date, addDays(start, -CARRY_DAYS)),
          lte(pricesDaily.date, end),
        ),
      )
      .orderBy(pricesDaily.ticker, pricesDaily.date);
    for (const row of rows) {
      const list = series.get(row.ticker) ?? [];
      list.push({ date: row.date, close: row.close });
      series.set(row.ticker, list);
    }
  }
  return (ticker, date) => asOf(series.get(ticker.toUpperCase()), date, (row) => row.close);
}

/** Binary search for the last entry on or before `date`. */
function asOf<T extends { date: IsoDate }, R>(list: T[] | undefined, date: IsoDate, pick: (row: T) => R): R | null {
  if (!list || list.length === 0 || list[0].date > date) return null;
  let low = 0;
  let high = list.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (list[middle].date <= date) low = middle;
    else high = middle - 1;
  }
  return pick(list[low]);
}

/* ------------------------------------------------------------------ */
/* FX                                                                  */
/* ------------------------------------------------------------------ */

const FX_PAIR: [Currency, Currency] = ['USD', 'AUD'];

export async function ensureFx(deps: Deps, start: IsoDate, end: IsoDate): Promise<void> {
  if (!deps.fx) return;
  const [base, quote] = FX_PAIR;
  const [have] = await deps.db
    .select({ first: min(fxDaily.date), last: max(fxDaily.date) })
    .from(fxDaily)
    .where(and(eq(fxDaily.base, base), eq(fxDaily.quote, quote)));
  const ranges: [IsoDate, IsoDate][] = [];
  if (!have?.first || !have.last) ranges.push([start, end]);
  else {
    if (have.first > addDays(start, 4)) ranges.push([start, addDays(have.first, -1)]);
    if (have.last < end) ranges.push([addDays(have.last, 1), end]);
  }
  for (const [from, to] of ranges) {
    if (from > to) continue;
    try {
      const rates = await deps.fx.rates(base, quote, from, to);
      const rows = rates.filter((rate) => rate.rate > 0).map((rate) => ({ base, quote, date: rate.date, rate: rate.rate }));
      await runBatch(
        deps.db,
        chunkRows(fxDaily, rows).map((chunk) => deps.db.insert(fxDaily).values(chunk).onConflictDoNothing()),
      );
    } catch (error) {
      console.warn('FX fetch failed', error instanceof Error ? error.message : error);
    }
  }
}

export type FxLookup = (date: IsoDate) => FxRates;

/**
 * As-of USD↔AUD rates. Falls back to the nearest known rate. Missing rates
 * are fetched on demand (at most every few hours per range), so a fresh
 * install converts correctly before the first daily job.
 */
export async function fxLookup(deps: Deps, start: IsoDate, end: IsoDate): Promise<FxLookup> {
  const [base, quote] = FX_PAIR;
  const checkKey = `fx-checked:${start}:${end}`;
  if (deps.fx && !(await cacheGet(deps, checkKey))) {
    await ensureFx(deps, addDays(start, -CARRY_DAYS), end);
    await cacheSet(deps, checkKey, true, 6 * 3600);
  }
  const rows = await deps.db
    .select({ date: fxDaily.date, rate: fxDaily.rate })
    .from(fxDaily)
    .where(and(eq(fxDaily.base, base), eq(fxDaily.quote, quote), gte(fxDaily.date, addDays(start, -CARRY_DAYS)), lte(fxDaily.date, end)))
    .orderBy(fxDaily.date);
  let fallback = rows[0]?.rate ?? null;
  if (!fallback) {
    const [latest] = await deps.db
      .select({ rate: fxDaily.rate })
      .from(fxDaily)
      .where(and(eq(fxDaily.base, base), eq(fxDaily.quote, quote)))
      .orderBy(desc(fxDaily.date))
      .limit(1);
    fallback = latest?.rate ?? null;
  }
  return (date) => {
    const rate = asOf(rows, date, (row) => row.rate) ?? fallback;
    return rate ? { 'USD->AUD': rate } : {};
  };
}
