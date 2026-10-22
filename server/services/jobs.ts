/**
 * The daily job (cron on Workers, node-cron on Node), in three passes so the
 * heavy work can't hold up the rest:
 *  1. sync each connection (which also collects ready balance-history reports);
 *  2. write each household's snapshot for the day;
 *  3. history work the syncs left: due history loads, missed days.
 * Failures are isolated per connection and per household.
 *
 * Each run is recorded in job_runs, written 'running' as it starts: a Worker
 * stopped part-way can't log anything, so the next run marks a row left
 * running as interrupted. Old log entries are pruned here.
 */
import { and, desc, eq, gte, lt } from 'drizzle-orm';
import type { StatusResponse } from '../../shared/types';
import { connections, households, jobRuns, sessions, syncRuns } from '../db/schema';
import { Tenant } from '../db/tenant';
import type { Deps } from '../ports';
import { addDays, marketDate } from '../../shared/dates';
import { historyKeepsStopping, INTERRUPTED, interruptedSince, JOB_MAX_MS, pruneLogs } from './activity';
import { cachePrune } from './cache';
import { ensureFx } from './pricing';
import { typeHandEnteredSecurities } from './securityTypes';
import { snapshotHousehold } from './snapshots';
import { activeConnections, runPendingWork, syncConnection } from './sync';
import { describeError } from '../lib/errors';


export interface DailyReport {
  date: string;
  households: number;
  errors: string[];
  /** Runs found stopped part-way since the previous job started (all households). */
  interrupted: number;
}

export async function runDaily(deps: Deps): Promise<DailyReport> {
  const id = crypto.randomUUID();
  const startedAt = deps.now().getTime();
  const date = marketDate(deps.now());
  const errors: string[] = [];
  // Interruptions found after the previous job finished are this job's to report.
  const [previous] = await deps.db.select({ finishedAt: jobRuns.finishedAt }).from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(1);
  const reportSince = previous?.finishedAt ?? startedAt - 24 * 3600 * 1000;
  // Any earlier run still 'running' was stopped part-way (one runs at a time).
  const stopped = await deps.db
    .update(jobRuns)
    .set({ status: 'interrupted' })
    .where(and(eq(jobRuns.status, 'running'), lt(jobRuns.startedAt, startedAt)))
    .returning({ date: jobRuns.date });
  for (const run of stopped) errors.push(`The daily job of ${run.date} was stopped before finishing.`);
  await deps.db.insert(jobRuns).values({ id, job: 'daily', date, startedAt, finishedAt: startedAt, status: 'running', households: 0, errors: [] });

  await ensureFx(deps, addDays(date, -7), date);
  await cachePrune(deps);
  await pruneLogs(deps);
  await deps.db.delete(sessions).where(lt(sessions.expiresAt, startedAt));

  const rows = await deps.db.select({ id: households.id }).from(households);
  const tenants = rows.map((row) => new Tenant(deps.db, row.id));
  const byTenant = new Map<Tenant, { id: string }[]>();
  for (const tenant of tenants) byTenant.set(tenant, await activeConnections(tenant));

  // 1. Syncs (history work waits for pass 3).
  for (const [tenant, list] of byTenant) {
    for (const connection of list) {
      try {
        await syncConnection(deps, tenant, connection.id, 'nightly', { history: false });
      } catch (error) {
        errors.push(`sync ${connection.id}: ${describeError(error)}`);
      }
    }
  }
  // 2. Snapshots.
  for (const tenant of tenants) {
    try {
      await typeHandEnteredSecurities(deps, tenant);
    } catch (error) {
      errors.push(`types ${tenant.householdId}: ${describeError(error)}`);
    }
    try {
      await snapshotHousehold(deps, tenant, date, 'nightly');
    } catch (error) {
      errors.push(`snapshot ${tenant.householdId}: ${describeError(error)}`);
    }
  }
  // 3. History loads that are due (never run, stopped part-way, or a late
  // transaction) and days the syncs missed.
  for (const [tenant, list] of byTenant) {
    for (const connection of list) {
      try {
        await runPendingWork(deps, tenant, connection.id, 'nightly');
      } catch (error) {
        errors.push(`history ${connection.id}: ${describeError(error)}`);
      }
    }
  }

  // Runs stopped part-way since the previous job (found when the next run of
  // the same connection took its lease, including in pass 1 above).
  const interrupted = await interruptedSince(deps, reportSince);
  if (errors.length > 0) console.error('Daily job errors', errors);
  await deps.db
    .update(jobRuns)
    .set({ finishedAt: deps.now().getTime(), status: errors.length > 0 ? 'errors' : 'ok', households: rows.length, errors })
    .where(eq(jobRuns.id, id));
  return { date, households: rows.length, errors, interrupted };
}

/** A daily job that hasn't started for this long is late (it runs every 24 hours). */
const LATE_MS = 26 * 3600 * 1000;
/** How far back stopped runs are shown. */
const SHOW_INTERRUPTED_MS = 3 * 24 * 3600 * 1000;

/** What didn't finish, for the household's warning banner. */
export async function backgroundStatus(deps: Deps, tenant: Tenant): Promise<StatusResponse> {
  const now = deps.now().getTime();
  const [job] = await deps.db
    .select({ date: jobRuns.date, status: jobRuns.status, startedAt: jobRuns.startedAt })
    .from(jobRuns)
    .orderBy(desc(jobRuns.startedAt))
    .limit(1);
  let nightly: StatusResponse['nightly'] = null;
  if (job) {
    const stopped = job.status === 'interrupted' || (job.status === 'running' && now - job.startedAt > JOB_MAX_MS);
    const state = stopped ? 'interrupted' : job.status === 'running' ? 'running' : now - job.startedAt > LATE_MS ? 'late' : 'finished';
    nightly = { date: job.date, state };
  }

  const names = new Map(
    (await tenant.db.select({ id: connections.id, name: connections.institutionName }).from(connections).where(tenant.scope(connections))).map(
      (row) => [row.id, row.name ?? 'A login'],
    ),
  );
  const interrupted = (
    await tenant.db
      .select({ connectionId: syncRuns.connectionId, action: syncRuns.action, startedAt: syncRuns.startedAt })
      .from(syncRuns)
      .where(tenant.scope(syncRuns, eq(syncRuns.errorCode, INTERRUPTED), gte(syncRuns.startedAt, now - SHOW_INTERRUPTED_MS)))
      .orderBy(desc(syncRuns.startedAt))
      .limit(10)
  ).map((run) => ({ ...run, institutionName: names.get(run.connectionId) ?? 'A login' }));
  const historyStopped: StatusResponse['historyStopped'] = [];
  for (const connectionId of new Set(interrupted.map((run) => run.connectionId))) {
    if (await historyKeepsStopping(tenant, connectionId)) historyStopped.push({ connectionId, institutionName: names.get(connectionId) ?? 'A login' });
  }
  return { nightly, interrupted, historyStopped };
}
