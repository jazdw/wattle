/**
 * The daily write budget. D1 Free allows 100,000 rows written a day (UTC),
 * index entries included, and past that every write fails until midnight
 * UTC: sign-in, syncs, everything. A first history load for a large
 * investment login can write more than that on its own, so history and
 * bank-report jobs check the day's total first and, past the budget
 * (D1_DAILY_WRITE_BUDGET), wait for the next day: a load spreads over days
 * and leaves the rest of the day's writes to syncs, snapshots and requests.
 *
 * The total is D1's own count (each result's rows_written, see
 * adapters/d1Meter.ts), added up per job and per request that wrote any.
 * Without a meter (Node, tests) nothing is counted, so nothing waits.
 */
import { sql } from 'drizzle-orm';
import { dbUsage } from '../db/schema';
import type { Deps } from '../ports';
import { RetryLater, type JobType } from './jobRunner';

/** The jobs that do the heavy writing, and can wait a day. */
const BUDGETED: ReadonlySet<JobType> = new Set<JobType>(['history_plan', 'history_prices', 'history_block', 'history_finish', 'report_collect', 'report_account', 'report_finish']);
/** Rows written per built row, at most (a daily row and its indexes). */
const WRITES_PER_ROW = 4;
/** After midnight UTC: a little later, so the day has surely turned. */
const RESET_MARGIN_SECONDS = 120;

/** How a job waiting at the budget says so (shown on its login while it waits). */
export const WAITING_FOR_TOMORROW = 'Waiting for tomorrow (UTC)';

const utcDay = (deps: Deps) => deps.now().toISOString().slice(0, 10);

/** Seconds until just after the next midnight UTC, when D1's daily limits reset. */
export function secondsUntilReset(deps: Deps): number {
  const now = deps.now().getTime();
  const midnight = Date.UTC(deps.now().getUTCFullYear(), deps.now().getUTCMonth(), deps.now().getUTCDate() + 1);
  return Math.ceil((midnight - now) / 1000) + RESET_MARGIN_SECONDS;
}

export async function rowsWrittenToday(deps: Deps): Promise<number> {
  const [row] = await deps.db.select({ rows: dbUsage.rowsWritten }).from(dbUsage).where(sql`${dbUsage.day} = ${utcDay(deps)}`);
  return row?.rows ?? 0;
}

/** Add what this invocation wrote since `since` (a meter reading) to the day's total. */
export async function recordWrites(deps: Deps, since: number): Promise<void> {
  if (!deps.writes) return;
  const rows = deps.writes.rowsWritten() - since;
  if (rows <= 0) return;
  await deps.db
    .insert(dbUsage)
    .values({ day: utcDay(deps), rowsWritten: rows })
    .onConflictDoUpdate({ target: dbUsage.day, set: { rowsWritten: sql`${dbUsage.rowsWritten} + ${rows}` } });
}

/** Before a heavy job: wait for tomorrow if it could take the day past the budget. Not a failed attempt. */
export async function checkWriteBudget(deps: Deps, type: JobType): Promise<void> {
  const budget = deps.config.dailyWriteBudget;
  if (!budget || !deps.writes || !BUDGETED.has(type)) return;
  const written = await rowsWrittenToday(deps);
  if (written + deps.config.jobChunkRows * WRITES_PER_ROW > budget) {
    throw new RetryLater(secondsUntilReset(deps), `${WAITING_FOR_TOMORROW}: ${written.toLocaleString('en-US')} of today's ${budget.toLocaleString('en-US')} database writes used.`);
  }
}

/** D1 refusing work because a daily limit (rows written or read) was reached. */
export function isDailyLimitError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}` : String(error);
  return /D1/i.test(message) && /daily/i.test(message) && /limit/i.test(message);
}
