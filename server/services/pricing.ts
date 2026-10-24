/**
 * End-of-day prices and FX rates, cached in prices_daily / fx_daily (public
 * reference data shared by all households). Lookups carry the last known
 * value forward over weekends and holidays.
 */
import { and, desc, eq, gte, inArray, lte, max, min, sql } from 'drizzle-orm';
import { addDays, lastTradingDay, type IsoDate } from '../../shared/dates';
import type { Currency, FxRates } from '../../shared/money';
import type { BatchItem } from 'drizzle-orm/batch';
import { ProviderHttpError } from '../adapters/marketData';
import { chunkRows, inChunks, runAtomic } from '../db/batch';
import { fxDaily, priceRuns, pricesDaily, type PriceCall, type PriceChange } from '../db/schema';
import type { DailyClose, Deps, SecurityDescription } from '../ports';
import { ProviderBackoffError } from './backoff';
import { cacheGet, cacheGetMany, cacheSet, cacheSetMany } from './cache';
import { describeError } from '../lib/errors';

/** Look back this far for the last close before a range starts. */
const CARRY_DAYS = 10;
/** How long to remember that the provider doesn't know a ticker. */
const UNKNOWN_TTL_SECONDS = 7 * 24 * 3600;

type PriceRow = typeof pricesDaily.$inferInsert;

const unknownKey = (ticker: string) => `noprice:${ticker}`;

function normalise(tickers: string[]): string[] {
  return [...new Set(tickers.map((ticker) => ticker.toUpperCase()))];
}

/** First and last stored close per ticker, up to `upTo` (later ones can't be right). */
async function coverage(deps: Deps, tickers: string[], upTo: IsoDate) {
  const byTicker = new Map<string, { first: IsoDate | null; last: IsoDate | null }>();
  for (const chunk of inChunks(tickers)) {
    const rows = await deps.db
      .select({ ticker: pricesDaily.ticker, first: min(pricesDaily.date), last: max(pricesDaily.date) })
      .from(pricesDaily)
      .where(and(inArray(pricesDaily.ticker, chunk), lte(pricesDaily.date, upTo)))
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

/**
 * One price_runs entry: the provider calls made, then the stored values and
 * the log row written together in one atomic batch (finish). A run that
 * fetched nothing logs why (skipped); one whose batch fails logs the failure.
 */
class PriceRun {
  readonly calls: PriceCall[] = [];
  readonly changes: PriceChange[] = [];
  saved = 0;
  private readonly deps: Deps;
  private readonly kind: 'latest' | 'history' | 'fx';
  private readonly startedAt: number;

  constructor(deps: Deps, kind: 'latest' | 'history' | 'fx') {
    this.deps = deps;
    this.kind = kind;
    this.startedAt = deps.now().getTime();
  }

  /** Call a provider, recording the call; failures are recorded and rethrown. */
  async call<T>(call: Omit<PriceCall, 'returned' | 'error'>, work: () => Promise<T>, returned: (result: T) => number): Promise<T> {
    try {
      const result = await work();
      this.calls.push({ ...call, returned: returned(result) });
      return result;
    } catch (error) {
      this.calls.push({ ...call, returned: 0, error: (describeError(error)).slice(0, 200) });
      throw error;
    }
  }

  private row(outcome: 'ok' | 'error' | 'skipped', extra: { error?: string; note?: string } = {}) {
    return this.deps.db.insert(priceRuns).values({
      id: crypto.randomUUID(),
      kind: this.kind,
      outcome,
      error: extra.error ?? null,
      note: extra.note ?? null,
      startedAt: this.startedAt,
      finishedAt: this.deps.now().getTime(),
      calls: this.calls,
      saved: this.saved,
      changes: this.changes.slice(0, 500),
    });
  }

  /** Nothing needed fetching. */
  async skipped(note: string): Promise<void> {
    await this.row('skipped', { note });
  }

  /**
   * Write `statements` (the fetched values) and the log row atomically. If
   * that fails, log the failure on its own (best effort) and rethrow.
   */
  async finish(statements: BatchItem<'sqlite'>[]): Promise<void> {
    try {
      await runAtomic(this.deps.db, [...statements, this.row('ok')]);
    } catch (error) {
      try {
        this.saved = 0;
        await this.row('error', { error: (describeError(error)).slice(0, 500) });
      } catch (logError) {
        console.error('Could not write the price log', describeError(logError));
      }
      throw error;
    }
  }
}

/** Stored closes for these rows' tickers and dates, to log which values change. */
async function storedCloses(deps: Deps, rows: PriceRow[]) {
  const stored = new Map<string, { close: number; source: string }>();
  const dates = rows.map((row) => row.date).sort();
  for (const chunk of inChunks(normalise(rows.map((row) => row.ticker)))) {
    const found = await deps.db
      .select({ ticker: pricesDaily.ticker, date: pricesDaily.date, close: pricesDaily.close, source: pricesDaily.source })
      .from(pricesDaily)
      .where(and(inArray(pricesDaily.ticker, chunk), gte(pricesDaily.date, dates[0]), lte(pricesDaily.date, dates[dates.length - 1])));
    for (const row of found) stored.set(`${row.ticker}|${row.date}`, { close: row.close, source: row.source });
  }
  return stored;
}

/**
 * Statements storing closes. With `replace`, a later source (Tiingo) replaces
 * an earlier one (Plaid) for the same day; without, existing closes are kept.
 */
export function closeStatements(deps: Deps, rows: PriceRow[], options: { replace: boolean }): BatchItem<'sqlite'>[] {
  return chunkRows(pricesDaily, rows).map((chunk) => {
    const insert = deps.db.insert(pricesDaily).values(chunk);
    return options.replace
      ? insert.onConflictDoUpdate({
          target: [pricesDaily.ticker, pricesDaily.date],
          set: { close: sql`excluded.close`, source: sql`excluded.source` },
        })
      : insert.onConflictDoNothing();
  });
}

/** Store closes now (manual entry, tests); see closeStatements. */
export async function saveCloses(deps: Deps, rows: PriceRow[], options: { replace: boolean }): Promise<void> {
  await runAtomic(deps.db, closeStatements(deps, rows, options));
}

/** Store fetched closes as part of a price run, logging values that change. */
async function saveFetchedCloses(deps: Deps, run: PriceRun, rows: PriceRow[]): Promise<void> {
  if (rows.length > 0) {
    const stored = await storedCloses(deps, rows);
    for (const row of rows) {
      const before = stored.get(`${row.ticker}|${row.date}`);
      if (before && Math.abs(before.close - row.close) > 1e-9) {
        run.changes.push({ ticker: row.ticker, date: row.date, before: before.close, beforeSource: before.source, after: row.close, afterSource: row.source });
      }
    }
    run.saved = rows.length;
  }
  await run.finish(closeStatements(deps, rows, { replace: true }));
}

/**
 * Make sure each ticker has its latest close as of `date` (the nightly
 * snapshot, manual holdings). What's missing is fetched in bulk where the
 * provider can (Tiingo's IEX endpoint for stocks and ETFs), then one request
 * per remaining ticker (mutual funds).
 */
export async function ensureRecentCloses(deps: Deps, tickers: string[], date: IsoDate): Promise<void> {
  if (!deps.prices || tickers.length === 0) return;
  const expected = lastTradingDay(date);
  const unique = normalise(tickers);
  const have = await coverage(deps, unique, date);
  const unknown = await knownUnknowns(deps, unique);
  const stale = unique.filter((ticker) => !unknown.has(ticker) && !((have.get(ticker)?.last ?? '') >= expected));
  const run = new PriceRun(deps, 'latest');
  if (stale.length === 0) {
    await run.skipped(`All ${unique.length} tickers already have a close for ${expected} (or are unknown to the provider).`);
    return;
  }

  const prices = deps.prices;
  const rows: PriceRow[] = [];
  let bulk = new Map<string, DailyClose>();
  if (prices.latestCloses) {
    try {
      bulk = await run.call({ provider: prices.name, endpoint: 'latest', tickers: stale }, () => prices.latestCloses!(stale), (result) => result.size);
    } catch (error) {
      console.warn('Bulk price fetch failed', describeError(error));
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
    const from = last ? addDays(last, 1) : addDays(date, -7);
    try {
      closes = await run.call({ provider: prices.name, endpoint: 'daily', tickers: [ticker], from, to: date }, () => prices.dailyCloses(ticker, from, date), (result) => result.length);
    } catch (error) {
      console.warn('Price fetch failed', ticker, describeError(error));
      continue;
    }
    if (closes.length === 0 && !last && !fromBulk) newlyUnknown.push(ticker);
    for (const close of closes) rows.push({ ticker, date: close.date, close: close.close, currency: 'USD', source: 'tiingo' });
  }
  await saveFetchedCloses(deps, run, rows);
  await cacheSetMany(deps, newlyUnknown.map((ticker) => [unknownKey(ticker), true]), UNKNOWN_TTL_SECONDS);
}

/** Tickers whose closes couldn't be fetched, and whether the provider was refusing for too many requests. */
export interface CloseGaps {
  failed: string[];
  rateLimited: boolean;
}

/**
 * Make sure prices_daily covers [start, end] for each ticker (history
 * backfill), fetching only the missing edges. There's no bulk history
 * endpoint, so this is one request per ticker that needs it.
 */
export async function ensureCloses(deps: Deps, tickers: string[], start: IsoDate, end: IsoDate): Promise<CloseGaps> {
  const gaps: CloseGaps = { failed: [], rateLimited: false };
  if (!deps.prices || tickers.length === 0) return gaps;
  const unique = normalise(tickers);
  const have = await coverage(deps, unique, end);
  const unknown = await knownUnknowns(deps, unique);
  const prices = deps.prices;
  const run = new PriceRun(deps, 'history');
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
      // Once the provider says "too many requests", asking again only makes it worse.
      if (gaps.rateLimited) {
        gaps.failed.push(ticker);
        break;
      }
      let closes: DailyClose[];
      try {
        closes = await run.call({ provider: prices.name, endpoint: 'daily', tickers: [ticker], from, to }, () => prices.dailyCloses(ticker, from, to), (result) => result.length);
      } catch (error) {
        console.warn('Price fetch failed', ticker, describeError(error));
        gaps.failed.push(ticker);
        gaps.rateLimited ||= (error instanceof ProviderHttpError && error.status === 429) || error instanceof ProviderBackoffError;
        break;
      }
      if (closes.length === 0 && !stored) {
        newlyUnknown.push(ticker);
        break;
      }
      for (const close of closes) rows.push({ ticker, date: close.date, close: close.close, currency: 'USD', source: 'tiingo' });
    }
  }
  if (run.calls.length === 0 && gaps.failed.length === 0) {
    await run.skipped(`All ${unique.length} tickers already cover ${start} to ${end} (or are unknown to the provider).`);
    return gaps;
  }
  await saveFetchedCloses(deps, run, rows);
  await cacheSetMany(deps, newlyUnknown.map((ticker) => [unknownKey(ticker), true]), UNKNOWN_TTL_SECONDS);
  return gaps;
}

/** Remember what a ticker is for a month (it rarely changes). */
const DESCRIBE_TTL_SECONDS = 30 * 24 * 3600;
const describeKey = (ticker: string) => `describe:${ticker}`;
/** US mutual fund tickers are five letters ending in X (VTSAX, VFFVX): a convention, used only as a fallback. */
const LOOKS_LIKE_US_FUND = /^[A-Z]{4}X$/;

/**
 * What each ticker is (stock, ETF or mutual fund) and its name, for tickers
 * entered by hand. Asks the price provider once per ticker (cached), falling
 * back to the naming convention; tickers it can't tell are left out.
 */
export async function describeTickers(deps: Deps, tickers: string[]): Promise<Map<string, SecurityDescription>> {
  const unique = normalise(tickers);
  const found = await cacheGetMany<SecurityDescription | false>(deps, unique.map(describeKey));
  const result = new Map<string, SecurityDescription>();
  const learned: [string, SecurityDescription | false][] = [];
  for (const ticker of unique) {
    let description = found.get(describeKey(ticker));
    if (description === undefined && deps.prices?.describe) {
      try {
        description = (await deps.prices.describe(ticker)) ?? false;
        learned.push([describeKey(ticker), description]);
      } catch (error) {
        console.warn('Ticker lookup failed', ticker, describeError(error));
      }
    }
    if (description) result.set(ticker, description);
    else if (LOOKS_LIKE_US_FUND.test(ticker)) result.set(ticker, { type: 'mutual fund', name: null });
  }
  await cacheSetMany(deps, learned, DESCRIBE_TTL_SECONDS);
  return result;
}

export type CloseLookup = (ticker: string, date: IsoDate) => number | null;
/** The close in effect on a date, with the day it's from (earlier when that day's isn't stored yet). */
export type DatedCloseLookup = (ticker: string, date: IsoDate) => { date: IsoDate; close: number } | null;

/** As-of close lookup over [start, end] for the given tickers. */
export async function closeLookup(deps: Deps, tickers: string[], start: IsoDate, end: IsoDate): Promise<CloseLookup> {
  const dated = await datedCloseLookup(deps, tickers, start, end);
  return (ticker, date) => dated(ticker, date)?.close ?? null;
}

/** As closeLookup, also saying which day each close is from. */
export async function datedCloseLookup(deps: Deps, tickers: string[], start: IsoDate, end: IsoDate): Promise<DatedCloseLookup> {
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
  return (ticker, date) => asOf(series.get(ticker.toUpperCase()), date, (row) => row);
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

export async function ensureFx(deps: Deps, start: IsoDate, end: IsoDate): Promise<{ failed: boolean }> {
  if (!deps.fx) return { failed: false };
  const fx = deps.fx;
  const run = new PriceRun(deps, 'fx');
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
  const rows: (typeof fxDaily.$inferInsert)[] = [];
  let failed = false;
  for (const [from, to] of ranges) {
    if (from > to) continue;
    try {
      const rates = await run.call({ provider: fx.name, endpoint: 'rates', tickers: [`${base}/${quote}`], from, to }, () => fx.rates(base, quote, from, to), (result) => result.length);
      rows.push(...rates.filter((rate) => rate.rate > 0).map((rate) => ({ base, quote, date: rate.date, rate: rate.rate })));
    } catch (error) {
      console.warn('FX fetch failed', describeError(error));
      failed = true;
    }
  }
  if (run.calls.length === 0) {
    await run.skipped(`${base}/${quote} rates already cover ${start} to ${end}.`);
    return { failed };
  }
  // Rates are never overwritten (insert-or-ignore), so none "change".
  run.saved = rows.length;
  await run.finish(chunkRows(fxDaily, rows).map((chunk) => deps.db.insert(fxDaily).values(chunk).onConflictDoNothing()));
  return { failed };
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
