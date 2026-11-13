/**
 * Each account's stored history, summed up for the history timeline: its
 * balances as runs of consecutive days from one source (days without one
 * are gaps), the days each source's transactions cover, and whether the
 * institution's balance has stopped updating.
 *
 * A day without transactions leaves no row, so the days a source covered are
 * recorded where its transactions are written (transaction_ranges, through
 * rangeStatements): an import, a bank report, a complete Plaid fetch.
 */
import { asc, count, eq, gte, inArray, lte } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { addDays, marketDate, mergeSpans, type IsoDate } from '../../shared/dates';
import type { CoverageResponse, CoverageRun, CoverageSource, TransactionRange } from '../../shared/types';
import { accountDaily, accounts, transactionRanges, transactions, type TRANSACTION_SOURCES as SOURCES } from '../db/schema';
import type { Tenant } from '../db/tenant';
import type { Deps } from '../ports';
import { counted } from './importedRecord';

/** Days a balance from the institution may sit unchanged before, with transactions after, it's said to have stopped updating. */
export const UNCHANGED_DAYS = 7;

const BALANCE_SOURCES: Record<string, CoverageSource> = { import: 'files', snapshot: 'bank', rebuilt: 'bank', manual: 'you' };
const TRANSACTION_SOURCES: Record<string, CoverageSource> = { import: 'files', report: 'bank', plaid: 'bank' };

type TransactionSource = (typeof SOURCES)[number];

/**
 * Statements recording that a source's transactions in an account cover
 * `from`–`to`: the ranges of that source it overlaps or touches give way to
 * their union, so each stays one row. Nothing when one already covers it (a
 * file imported again).
 */
export async function rangeStatements(tenant: Tenant, accountId: string, source: TransactionSource, from: IsoDate, to: IsoDate, now: number): Promise<BatchItem<'sqlite'>[]> {
  if (to < from) return [];
  const touching = await tenant.db
    .select({ id: transactionRanges.id, from: transactionRanges.from, to: transactionRanges.to })
    .from(transactionRanges)
    .where(tenant.scope(transactionRanges, eq(transactionRanges.accountId, accountId), eq(transactionRanges.source, source), lte(transactionRanges.from, addDays(to, 1)), gte(transactionRanges.to, addDays(from, -1))));
  if (touching.some((range) => range.from <= from && range.to >= to)) return [];
  const [merged] = mergeSpans([...touching, { from, to }]);
  return [
    ...(touching.length > 0 ? [tenant.db.delete(transactionRanges).where(tenant.scope(transactionRanges, inArray(transactionRanges.id, touching.map((range) => range.id))))] : []),
    tenant.db.insert(transactionRanges).values({ id: crypto.randomUUID(), householdId: tenant.householdId, accountId, source, from: merged.from, to: merged.to, recordedAt: now }),
  ];
}

/**
 * One account's transaction ranges for the timeline: merged per source (a
 * day with transactions no range of its source covers, stored before ranges
 * were recorded, counts as covered), then split where another source's days
 * start or end, each part with the counted transactions in it.
 */
export function coverageRanges(stored: { source: CoverageSource; from: IsoDate; to: IsoDate }[], perDay: { date: IsoDate; source: CoverageSource; count: number }[]): TransactionRange[] {
  const sources = [...new Set([...stored.map((range) => range.source), ...perDay.map((day) => day.source)])];
  const spans = new Map(
    sources.map((source) => {
      const own = stored.filter((range) => range.source === source);
      const loose = perDay.filter((day) => day.source === source && !own.some((range) => range.from <= day.date && range.to >= day.date)).map((day) => ({ from: day.date, to: day.date }));
      return [source, mergeSpans([...own, ...loose])];
    }),
  );
  const cuts = [...new Set([...spans.values()].flat().flatMap((span) => [span.from, addDays(span.to, 1)]))].sort();
  const ranges: TransactionRange[] = [];
  for (const [source, list] of spans) {
    for (const span of list) {
      let from = span.from;
      for (const cut of cuts) {
        if (cut <= from || cut > span.to) continue;
        ranges.push({ from, to: addDays(cut, -1), source, count: 0 });
        from = cut;
      }
      ranges.push({ from, to: span.to, source, count: 0 });
    }
  }
  for (const day of perDay) {
    const range = ranges.find((found) => found.source === day.source && found.from <= day.date && found.to >= day.date);
    if (range) range.count += day.count;
  }
  return ranges.sort((a, b) => a.from.localeCompare(b.from) || a.source.localeCompare(b.source));
}

type Day = { accountId: string; date: string; balance: number; source: string; unmatched: boolean; priceSource: string | null };

/** One account's balances as runs: a new run where the source or whether it was filled changes, or a day is missing. */
export function balanceRuns(days: Day[]): CoverageRun[] {
  const runs: CoverageRun[] = [];
  for (const day of days) {
    const last = runs.at(-1);
    // A day carried from the one before belongs with it, filled.
    const source = day.source === 'carried' ? (last?.source ?? 'bank') : (BALANCE_SOURCES[day.source] ?? 'bank');
    const filled = day.source === 'carried' || day.unmatched || day.priceSource === 'interpolated';
    if (last && last.source === source && last.filled === filled && addDays(last.to, 1) === day.date) last.to = day.date as IsoDate;
    else runs.push({ from: day.date as IsoDate, to: day.date as IsoDate, source, filled });
  }
  return runs;
}

/**
 * The day the institution's balance last changed, when it's sat unchanged
 * for UNCHANGED_DAYS or more up to the account's latest day though a
 * transaction is dated after that: it has stopped updating. Null otherwise
 * (an account with nothing happening is unchanged and that's right).
 */
export function unchangedSince(days: Day[], lastTransaction: string | undefined): IsoDate | null {
  const last = days.at(-1);
  if (!last || (last.source !== 'snapshot' && last.source !== 'carried')) return null;
  let since = last.date;
  for (let index = days.length - 1; index >= 0; index--) {
    const day = days[index];
    if ((day.source !== 'snapshot' && day.source !== 'carried') || day.balance !== last.balance) break;
    since = day.date;
  }
  if (addDays(since as IsoDate, UNCHANGED_DAYS) > last.date) return null;
  return lastTransaction && lastTransaction > since ? (since as IsoDate) : null;
}

/** GET /api/coverage. */
export async function loadCoverage(deps: Deps, tenant: Tenant): Promise<CoverageResponse> {
  const [rows, days, perDay, stored] = await Promise.all([
    tenant.db.select({ id: accounts.id }).from(accounts).where(tenant.scope(accounts)),
    tenant.db
      .select({ accountId: accountDaily.accountId, date: accountDaily.date, balance: accountDaily.balance, source: accountDaily.source, unmatched: accountDaily.unmatched, priceSource: accountDaily.priceSource })
      .from(accountDaily)
      .where(tenant.scope(accountDaily))
      .orderBy(asc(accountDaily.accountId), asc(accountDaily.date)),
    tenant.db
      .select({ accountId: transactions.accountId, date: transactions.date, source: transactions.source, count: count() })
      .from(transactions)
      .where(tenant.scope(transactions, counted()))
      .groupBy(transactions.accountId, transactions.date, transactions.source)
      .orderBy(asc(transactions.date)),
    tenant.db
      .select({ accountId: transactionRanges.accountId, source: transactionRanges.source, from: transactionRanges.from, to: transactionRanges.to })
      .from(transactionRanges)
      .where(tenant.scope(transactionRanges)),
  ]);
  const daysOf = new Map<string, Day[]>();
  for (const day of days) daysOf.set(day.accountId, [...(daysOf.get(day.accountId) ?? []), day]);
  const perDayOf = new Map<string, { date: IsoDate; source: CoverageSource; count: number }[]>();
  for (const row of perDay) perDayOf.set(row.accountId, [...(perDayOf.get(row.accountId) ?? []), { date: row.date as IsoDate, source: TRANSACTION_SOURCES[row.source] ?? 'bank', count: row.count }]);
  const rangesOf = new Map<string, { source: CoverageSource; from: IsoDate; to: IsoDate }[]>();
  for (const row of stored) rangesOf.set(row.accountId, [...(rangesOf.get(row.accountId) ?? []), { source: TRANSACTION_SOURCES[row.source] ?? 'bank', from: row.from as IsoDate, to: row.to as IsoDate }]);
  return {
    today: marketDate(deps.now()),
    accounts: rows.map(({ id }) => {
      const accountDays = daysOf.get(id) ?? [];
      const transactionDays = perDayOf.get(id) ?? [];
      return { accountId: id, balances: balanceRuns(accountDays), transactions: coverageRanges(rangesOf.get(id) ?? [], transactionDays), unchangedSince: unchangedSince(accountDays, transactionDays.at(-1)?.date) };
    }),
  };
}
