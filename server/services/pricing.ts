/**
 * End-of-day prices and FX rates, cached in prices_daily / fx_daily (public
 * reference data shared by all households). Lookups carry the last known
 * value forward over weekends and holidays.
 */
import { and, desc, eq, gte, inArray, lte, max, min, sql } from 'drizzle-orm';
import { addDays, type IsoDate } from '../../shared/dates';
import type { Currency, FxRates } from '../../shared/money';
import { chunkRows, runBatch } from '../db/batch';
import { fxDaily, pricesDaily } from '../db/schema';
import type { Deps } from '../ports';
import { cacheGet, cacheSet } from './cache';

/** Look back this far for the last close before a range starts. */
const CARRY_DAYS = 10;

/**
 * Make sure prices_daily covers [start, end] for each ticker, fetching only
 * the missing edges. Tickers the provider doesn't know are remembered for a
 * week so they aren't requested every day.
 */
export async function ensureCloses(deps: Deps, tickers: string[], start: IsoDate, end: IsoDate): Promise<void> {
  if (!deps.prices || tickers.length === 0) return;
  const unique = [...new Set(tickers.map((ticker) => ticker.toUpperCase()))];
  const coverage = await deps.db
    .select({ ticker: pricesDaily.ticker, first: min(pricesDaily.date), last: max(pricesDaily.date) })
    .from(pricesDaily)
    .where(inArray(pricesDaily.ticker, unique))
    .groupBy(pricesDaily.ticker);
  const byTicker = new Map(coverage.map((row) => [row.ticker, row]));

  for (const ticker of unique) {
    if (await cacheGet(deps, `noprice:${ticker}`)) continue;
    const have = byTicker.get(ticker);
    const ranges: [IsoDate, IsoDate][] = [];
    if (!have?.first || !have.last) {
      ranges.push([start, end]);
    } else {
      // Small gaps at the edges (weekends) are expected; refetch only when
      // the stored range falls short by more than a long weekend.
      if (have.first > addDays(start, 4)) ranges.push([start, addDays(have.first, -1)]);
      if (have.last < end) ranges.push([addDays(have.last, 1), end]);
    }

    for (const [from, to] of ranges) {
      if (from > to) continue;
      let closes;
      try {
        closes = await deps.prices.dailyCloses(ticker, from, to);
      } catch (error) {
        console.warn('Price fetch failed', ticker, error instanceof Error ? error.message : error);
        continue;
      }
      if (closes.length === 0 && !have) {
        await cacheSet(deps, `noprice:${ticker}`, true, 7 * 24 * 3600);
        break;
      }
      const rows = closes.map((close) => ({ ticker, date: close.date, close: close.close, currency: 'USD', source: 'tiingo' }));
      await runBatch(
        deps.db,
        chunkRows(pricesDaily, rows).map((chunk) =>
          deps.db
            .insert(pricesDaily)
            .values(chunk)
            .onConflictDoUpdate({
              target: [pricesDaily.ticker, pricesDaily.date],
              set: { close: sql`excluded.close` },
            }),
        ),
      );
    }
  }
}

export type CloseLookup = (ticker: string, date: IsoDate) => number | null;

/** As-of close lookup over [start, end] for the given tickers. */
export async function closeLookup(deps: Deps, tickers: string[], start: IsoDate, end: IsoDate): Promise<CloseLookup> {
  const unique = [...new Set(tickers.map((ticker) => ticker.toUpperCase()))];
  const series = new Map<string, { date: IsoDate; close: number }[]>();
  if (unique.length > 0) {
    const rows = await deps.db
      .select({ ticker: pricesDaily.ticker, date: pricesDaily.date, close: pricesDaily.close })
      .from(pricesDaily)
      .where(
        and(
          inArray(pricesDaily.ticker, unique),
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
