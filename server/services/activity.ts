/**
 * The sync log: each sync, history load and balance-history collection is
 * recorded in sync_runs with its Plaid request ids, what it stored and what it
 * changed, so a wrong number can be traced back to the run that wrote it.
 *
 * A run's log row is written in the same atomic batch as its data (see
 * SyncRun.statement), so data never changes without a log entry. Runs that
 * fail, or find nothing to do, get a row of their own.
 */
import { desc, eq, lt, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { SyncChange, SyncRunSummary } from '../../shared/types';
import { PlaidApiError, type PlaidApi, type PlaidCall } from '../adapters/plaid';
import { runBatch } from '../db/batch';
import { jobRuns, priceRuns, syncRuns, type SYNC_ACTIONS, type SYNC_TRIGGERS } from '../db/schema';
import type { Tenant } from '../db/tenant';
import type { Deps } from '../ports';
import { describeError } from '../lib/errors';

export type SyncAction = (typeof SYNC_ACTIONS)[number];
export type SyncTrigger = (typeof SYNC_TRIGGERS)[number];

/** Changes kept per run; a first sync of a large brokerage can exceed it. */
const MAX_CHANGES = 500;
/** How long the logs are kept (matches the two years of history). */
const RETENTION_DAYS = 730;

export class SyncRun {
  readonly plaidCalls: PlaidCall[] = [];
  readonly counts: Record<string, number> = {};
  readonly changes: SyncChange[] = [];
  truncated = false;
  error: { code: string | null; message: string } | null = null;
  /** Shown with the run: why it was skipped, or something worth knowing. */
  note: string | null = null;
  private readonly id = crypto.randomUUID();
  private readonly deps: Deps;
  private readonly tenant: Tenant;
  private readonly connectionId: string;
  private readonly action: SyncAction;
  private readonly trigger: SyncTrigger;
  private readonly startedAt: number;

  constructor(deps: Deps, tenant: Tenant, connectionId: string, action: SyncAction, trigger: SyncTrigger) {
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
   * The log row, to include in the batch that writes the run's data. With
   * `skipped`, the run looked but had nothing to do (`note` says why).
   */
  statement(outcome: 'ok' | 'skipped' = 'ok'): BatchItem<'sqlite'> {
    return this.tenant.db.insert(syncRuns).values({
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
    });
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
  ]);
}
