/**
 * The sync log: each sync, history load and balance-history collection is
 * recorded in sync_runs with its Plaid request ids, what it stored and what it
 * changed, so a wrong number can be traced back to the run that wrote it.
 *
 * A run's log row is written in the same atomic batch as its data (see
 * SyncRun.statement), so data never changes without a log entry. Runs that
 * fail, or find nothing to do, get a row of their own.
 *
 * A Worker stopped part-way (CPU or time limit, crash) runs no more code, so
 * it can't log that. Runs that do real work write a 'running' row first
 * (SyncRun.begin); the next run to take the connection's lease turns any
 * still-running row into an INTERRUPTED error (closeInterruptedRuns), since
 * nothing else can be running then.
 */
import { and, asc, desc, eq, gt, lt, lte, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { BatchItem } from 'drizzle-orm/batch';
import type { ActivityEntry, ActivityResponse, SyncChange, SyncRunSummary } from '../../shared/types';
import { PlaidApiError, type PlaidApi, type PlaidCall } from '../adapters/plaid';
import { runBatch } from '../db/batch';
import { connections, jobRuns, priceRuns, snapshotRuns, syncRuns, type SYNC_ACTIONS, type SYNC_TRIGGERS } from '../db/schema';
import type { Tenant } from '../db/tenant';
import type { Deps } from '../ports';
import { describeError } from '../lib/errors';

export type SyncAction = (typeof SYNC_ACTIONS)[number];
export type SyncTrigger = (typeof SYNC_TRIGGERS)[number];

/** Changes kept per run; a first sync of a large brokerage can exceed it. */
const MAX_CHANGES = 500;
/** How long the logs are kept (matches the two years of history). */
const RETENTION_DAYS = 730;
/** Error code of a run that was stopped part-way. */
export const INTERRUPTED = 'INTERRUPTED';
export const INTERRUPTED_MESSAGE = 'Stopped before finishing, most likely by a Worker limit (CPU time, run time or requests). Its finished steps are kept.';
/**
 * A night's jobs finish within minutes; a daily job still 'running' after
 * this didn't finish (its jobs ran out of attempts, or weren't all added).
 */
export const NIGHTLY_MAX_MS = 6 * 3600 * 1000;

export class SyncRun {
  readonly plaidCalls: PlaidCall[] = [];
  readonly counts: Record<string, number> = {};
  readonly changes: SyncChange[] = [];
  truncated = false;
  error: { code: string | null; message: string } | null = null;
  /** Shown with the run: why it was skipped, or something worth knowing. */
  note: string | null = null;
  readonly id: string;
  private readonly deps: Deps;
  private readonly tenant: Tenant;
  private readonly connectionId: string;
  private readonly action: SyncAction;
  private readonly trigger: SyncTrigger;
  private readonly startedAt: number;
  private begun = false;

  /** `id`: given when the run spans several jobs (a history load), so each can find its row. */
  constructor(deps: Deps, tenant: Tenant, connectionId: string, action: SyncAction, trigger: SyncTrigger, id: string = crypto.randomUUID()) {
    this.id = id;
    this.deps = deps;
    this.tenant = tenant;
    this.connectionId = connectionId;
    this.action = action;
    this.trigger = trigger;
    this.startedAt = deps.now().getTime();
  }

  /** The Plaid client, recording every call in this run. */
  plaid(): PlaidApi {
    if (!this.deps.plaid) throw new Error('Plaid is not configured (PLAID_CLIENT_ID / PLAID_SECRET).');
    return this.deps.plaid.scoped(this.plaidCalls);
  }

  count(key: string, amount: number): void {
    this.counts[key] = (this.counts[key] ?? 0) + amount;
  }

  change(change: SyncChange): void {
    if (this.changes.length < MAX_CHANGES) this.changes.push(change);
    else this.truncated = true;
  }

  fail(error: unknown): void {
    this.error = {
      code: error instanceof PlaidApiError ? error.code : null,
      message: (describeError(error)).slice(0, 500),
    };
  }

  /**
   * Record that the run has started, before work a Worker could be stopped
   * part-way through. The row is completed by statement(); left 'running', the
   * next run marks it interrupted.
   */
  async begin(): Promise<void> {
    if (this.begun) return;
    // A job running again (after being stopped part-way) starts its row afresh.
    const values = { ...this.values('running'), finishedAt: this.startedAt };
    await this.tenant.db
      .insert(syncRuns)
      .values(values)
      .onConflictDoUpdate({ target: syncRuns.id, set: values, setWhere: eq(syncRuns.householdId, this.tenant.householdId) });
    this.begun = true;
  }

  /**
   * The log row, to include in the batch that writes the run's data. With
   * `skipped`, the run looked but had nothing to do (`note` says why).
   * Completes the row begin() wrote, if any.
   */
  statement(outcome: 'ok' | 'skipped' | 'running' = 'ok'): BatchItem<'sqlite'> {
    const values = this.values(outcome);
    return this.tenant.db
      .insert(syncRuns)
      .values(values)
      .onConflictDoUpdate({ target: syncRuns.id, set: values, setWhere: eq(syncRuns.householdId, this.tenant.householdId) });
  }

  private values(outcome: 'ok' | 'skipped' | 'running'): typeof syncRuns.$inferInsert {
    return {
      id: this.id,
      householdId: this.tenant.householdId,
      connectionId: this.connectionId,
      action: this.action,
      trigger: this.trigger,
      startedAt: this.startedAt,
      finishedAt: this.deps.now().getTime(),
      outcome: this.error ? 'error' : outcome,
      errorCode: this.error?.code ?? null,
      errorMessage: this.error?.message ?? null,
      note: this.note,
      plaidCalls: this.plaidCalls,
      counts: this.counts,
      changes: this.changes,
      truncated: this.truncated,
    };
  }

  /**
   * Record Plaid calls made after the run's row was written (housekeeping
   * that must come after the data is safely stored) on that same row.
   */
  async recordLateCalls(): Promise<void> {
    await this.tenant.db
      .update(syncRuns)
      .set({ plaidCalls: this.plaidCalls, finishedAt: this.deps.now().getTime() })
      .where(this.tenant.scope(syncRuns, eq(syncRuns.id, this.id)));
  }

  /** Log a run that looked but had nothing to do. Throws if the row can't be written. */
  async skipped(note: string): Promise<void> {
    this.note = note;
    await this.statement('skipped');
  }

  /**
   * Log a failure. The run's data batch didn't apply, so this row is written
   * on its own; if even that fails, the caller's original error still
   * propagates (this never throws).
   */
  async failed(error: unknown): Promise<void> {
    this.fail(error);
    try {
      await this.statement();
    } catch (logError) {
      console.error('Could not write the sync log', describeError(logError));
    }
  }
}

/**
 * Mark runs still 'running' for this connection as stopped part-way. Call
 * holding the connection's lease: no run of it can be going on then. History
 * loads aren't included: they run as several jobs over time (not under the
 * lease throughout), and their jobs record a stopped attempt themselves.
 */
export async function closeInterruptedRuns(deps: Deps, tenant: Tenant, connectionId: string): Promise<number> {
  const closed = await tenant.db
    .update(syncRuns)
    .set({
      outcome: 'error',
      errorCode: INTERRUPTED,
      errorMessage: INTERRUPTED_MESSAGE,
      finishedAt: deps.now().getTime(),
    })
    .where(tenant.scope(syncRuns, eq(syncRuns.connectionId, connectionId), eq(syncRuns.outcome, 'running'), notInArray(syncRuns.action, ['history', 'balance_history'])))
    .returning({ id: syncRuns.id });
  return closed.length;
}

/**
 * Complete a run that spans several jobs (begun by one, finished by another):
 * its outcome, and counts added to those recorded so far. Returns the
 * statement in an array, for the batch that writes the run's last data (a
 * Drizzle statement is "thenable": returned bare from an async function, it
 * would run on the spot).
 */
export async function completeRunStatements(
  deps: Deps,
  tenant: Tenant,
  runId: string,
  values: { counts?: Record<string, number>; error?: { code: string | null; message: string } | null; note?: string | null },
): Promise<BatchItem<'sqlite'>[]> {
  const [row] = await tenant.db.select({ counts: syncRuns.counts, note: syncRuns.note }).from(syncRuns).where(tenant.scope(syncRuns, eq(syncRuns.id, runId)));
  const counts = { ...(row?.counts ?? {}) };
  for (const [key, value] of Object.entries(values.counts ?? {})) counts[key] = (counts[key] ?? 0) + value;
  return [
    tenant.db
      .update(syncRuns)
      .set({
        outcome: values.error ? 'error' : 'ok',
      errorCode: values.error?.code ?? null,
      errorMessage: values.error?.message.slice(0, 500) ?? null,
        note: values.note === undefined ? (row?.note ?? null) : values.note,
        counts,
        finishedAt: deps.now().getTime(),
      })
      .where(tenant.scope(syncRuns, eq(syncRuns.id, runId))),
  ];
}

/** Where a page of activity ends: entries sort by start time (newest first), then kind, then id. */
export interface ActivityCursor {
  startedAt: number;
  kind: ActivityEntry['kind'];
  id: string;
}

const KIND_ORDER: ActivityEntry['kind'][] = ['run', 'snapshot', 'nightly'];
const entryId = (entry: ActivityEntry) => (entry.kind === 'run' ? entry.run.id : entry.id);

function compareEntries(a: { startedAt: number; kind: ActivityEntry['kind']; id: string }, b: typeof a): number {
  return b.startedAt - a.startedAt || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Rows of one kind that sort after the cursor (several entries can share a start time). */
function afterCursor(cursor: ActivityCursor | null, kind: ActivityEntry['kind'], startedAt: SQLiteColumn, id: SQLiteColumn): SQL | undefined {
  if (!cursor) return undefined;
  const order = KIND_ORDER.indexOf(kind) - KIND_ORDER.indexOf(cursor.kind);
  if (order < 0) return lt(startedAt, cursor.startedAt);
  if (order > 0) return lte(startedAt, cursor.startedAt);
  return or(lt(startedAt, cursor.startedAt), and(eq(startedAt, cursor.startedAt), gt(id, cursor.id)));
}

/**
 * A page of the household's activity after `cursor`, newest first: every
 * login's runs, every snapshot, and the nightly job (shared by all
 * households: only its date and whether it finished are shown).
 */
export async function householdActivity(deps: Deps, tenant: Tenant, cursor: ActivityCursor | null, limit: number): Promise<ActivityResponse> {
  const now = deps.now().getTime();
  const names = new Map(
    (await tenant.db.select({ id: connections.id, name: connections.institutionName }).from(connections).where(tenant.scope(connections))).map((row) => [
      row.id,
      row.name ?? 'A login',
    ]),
  );
  const runs = await tenant.db
    .select({
      id: syncRuns.id,
      connectionId: syncRuns.connectionId,
      action: syncRuns.action,
      trigger: syncRuns.trigger,
      startedAt: syncRuns.startedAt,
      finishedAt: syncRuns.finishedAt,
      outcome: syncRuns.outcome,
      errorCode: syncRuns.errorCode,
      errorMessage: syncRuns.errorMessage,
      note: syncRuns.note,
      plaidCalls: syncRuns.plaidCalls,
      counts: syncRuns.counts,
      changes: syncRuns.changes,
      truncated: syncRuns.truncated,
    })
    .from(syncRuns)
    .where(tenant.scope(syncRuns, afterCursor(cursor, 'run', syncRuns.startedAt, syncRuns.id)))
    .orderBy(desc(syncRuns.startedAt), asc(syncRuns.id))
    .limit(limit);
  const snapshots = await tenant.db
    .select()
    .from(snapshotRuns)
    .where(tenant.scope(snapshotRuns, afterCursor(cursor, 'snapshot', snapshotRuns.startedAt, snapshotRuns.id)))
    .orderBy(desc(snapshotRuns.startedAt), asc(snapshotRuns.id))
    .limit(limit);
  const jobs = await deps.db
    .select({ id: jobRuns.id, date: jobRuns.date, status: jobRuns.status, startedAt: jobRuns.startedAt, finishedAt: jobRuns.finishedAt })
    .from(jobRuns)
    .where(afterCursor(cursor, 'nightly', jobRuns.startedAt, jobRuns.id))
    .orderBy(desc(jobRuns.startedAt), asc(jobRuns.id))
    .limit(limit);

  const entries: ActivityEntry[] = [
    ...runs.map(({ connectionId, ...run }) => ({
      kind: 'run' as const,
      startedAt: run.startedAt,
      connectionId,
      institutionName: names.get(connectionId) ?? 'A login',
      run,
    })),
    ...snapshots.map(({ householdId: _householdId, ...snapshot }) => ({ kind: 'snapshot' as const, ...snapshot })),
    ...jobs.map(({ status, ...job }) => {
      const stopped = status === 'interrupted' || (status === 'running' && now - job.startedAt > NIGHTLY_MAX_MS);
      return { kind: 'nightly' as const, ...job, state: stopped ? ('interrupted' as const) : status === 'running' ? ('running' as const) : ('finished' as const) };
    }),
  ].sort((a, b) => compareEntries({ ...a, id: entryId(a) }, { ...b, id: entryId(b) }));
  // Each source gave at most `limit` after the cursor, so the first `limit` merged are complete.
  const page = entries.slice(0, limit);
  const more = entries.length > limit || runs.length === limit || snapshots.length === limit || jobs.length === limit;
  const last = page.at(-1);
  return { entries: page, next: more && last ? { startedAt: last.startedAt, kind: last.kind, id: entryId(last) } : null };
}

/** A connection's most recent runs, newest first. */
export async function connectionActivity(tenant: Tenant, connectionId: string, limit = 50): Promise<SyncRunSummary[]> {
  return tenant.db
    .select({
      id: syncRuns.id,
      action: syncRuns.action,
      trigger: syncRuns.trigger,
      startedAt: syncRuns.startedAt,
      finishedAt: syncRuns.finishedAt,
      outcome: syncRuns.outcome,
      errorCode: syncRuns.errorCode,
      errorMessage: syncRuns.errorMessage,
      note: syncRuns.note,
      plaidCalls: syncRuns.plaidCalls,
      counts: syncRuns.counts,
      changes: syncRuns.changes,
      truncated: syncRuns.truncated,
    })
    .from(syncRuns)
    .where(tenant.scope(syncRuns, eq(syncRuns.connectionId, connectionId)))
    // Insertion order breaks ties between runs started in the same millisecond.
    .orderBy(desc(syncRuns.startedAt), desc(sql`rowid`))
    .limit(limit);
}

/** Delete log entries older than the retention period (all households; daily job). */
export async function pruneLogs(deps: Deps): Promise<void> {
  const cutoff = deps.now().getTime() - RETENTION_DAYS * 24 * 3600 * 1000;
  await runBatch(deps.db, [
    deps.db.delete(syncRuns).where(lt(syncRuns.startedAt, cutoff)),
    deps.db.delete(priceRuns).where(lt(priceRuns.startedAt, cutoff)),
    deps.db.delete(jobRuns).where(lt(jobRuns.startedAt, cutoff)),
    deps.db.delete(snapshotRuns).where(lt(snapshotRuns.startedAt, cutoff)),
  ]);
}
