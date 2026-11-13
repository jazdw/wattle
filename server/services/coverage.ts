/**
 * Each account's stored history, summed up for the history timeline: its
 * balances as runs of consecutive days from one source (days without one
 * are gaps), its transactions per day and source, and whether the
 * institution's balance has stopped updating.
 */
import { asc, count } from 'drizzle-orm';
import { addDays, marketDate, type IsoDate } from '../../shared/dates';
import type { AccountCoverage, CoverageResponse, CoverageRun, CoverageSource } from '../../shared/types';
import { accountDaily, accounts, transactions } from '../db/schema';
import type { Tenant } from '../db/tenant';
import type { Deps } from '../ports';
import { counted } from './importedRecord';

/** Days a balance from the institution may sit unchanged before, with transactions after, it's said to have stopped updating. */
export const UNCHANGED_DAYS = 7;

const BALANCE_SOURCES: Record<string, CoverageSource> = { import: 'files', snapshot: 'bank', rebuilt: 'bank', manual: 'you' };
const TRANSACTION_SOURCES: Record<string, CoverageSource> = { import: 'files', report: 'bank', plaid: 'bank' };

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
  const [rows, days, perDay] = await Promise.all([
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
  ]);
  const daysOf = new Map<string, Day[]>();
  for (const day of days) daysOf.set(day.accountId, [...(daysOf.get(day.accountId) ?? []), day]);
  const transactionsOf = new Map<string, AccountCoverage['transactions']>();
  for (const row of perDay) {
    const list = transactionsOf.get(row.accountId) ?? [];
    list.push({ date: row.date as IsoDate, source: TRANSACTION_SOURCES[row.source] ?? 'bank', count: row.count });
    transactionsOf.set(row.accountId, list);
  }
  return {
    today: marketDate(deps.now()),
    accounts: rows.map(({ id }) => {
      const accountDays = daysOf.get(id) ?? [];
      const accountTransactions = transactionsOf.get(id) ?? [];
      return { accountId: id, balances: balanceRuns(accountDays), transactions: accountTransactions, unchangedSince: unchangedSince(accountDays, accountTransactions.at(-1)?.date) };
    }),
  };
}
