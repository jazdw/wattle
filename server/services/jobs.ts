/**
 * The daily job (cron on Workers, a timer on Node). The cron itself only does
 * the light, global upkeep and adds the night's work as jobs
 * (./jobRunner), each run in its own invocation:
 *  - per household, a `sync` job for each active connection (group
 *    `nightly:<run>:<household>`), then a `snapshot` job waiting for them;
 *  - a `nightly_finish` job waiting for every household's snapshot (group
 *    `nightly:<run>`), which completes the job_runs row with the errors of
 *    any job that failed.
 * A failed sync is retried by its job (and the snapshot waits for it); one
 * household's failures never hold up another's.
 *
 * Each run is recorded in job_runs, written 'running' when the cron starts.
 * One still running when the next night starts didn't finish: marked
 * interrupted. Old log entries and finished jobs are pruned here.
 */
import { and, desc, eq, gte, inArray, like, lt, or } from 'drizzle-orm';
import type { StatusResponse } from '../../shared/types';
import { connections, households, jobRuns, jobs, sessions, syncRuns } from '../db/schema';
import { Tenant } from '../db/tenant';
import type { Deps } from '../ports';
import { addDays, marketDate } from '../../shared/dates';
import { INTERRUPTED, NIGHTLY_MAX_MS, pruneLogs } from './activity';
import { cachePrune } from './cache';
import { enqueueForHouseholds, pruneJobsStatement, sweep, type JobSpec } from './jobRunner';
import { ensureFx } from './pricing';
import { activeConnections } from './sync';
import { describeError } from '../lib/errors';

export interface DailyReport {
  /** The job_runs row; its status and errors are final once its jobs have run. */
  id: string;
  date: string;
  households: number;
}

export const nightlyGroup = (runId: string) => `nightly:${runId}`;

export async function runDaily(deps: Deps): Promise<DailyReport> {
  const id = crypto.randomUUID();
  const startedAt = deps.now().getTime();
  const date = marketDate(deps.now());
  const errors: string[] = [];
  // An earlier run still 'running' never finished (its jobs ran out of attempts
  // without completing it, or the cron was stopped before adding them).
  const stopped = await deps.db
    .update(jobRuns)
    .set({ status: 'interrupted' })
    .where(and(eq(jobRuns.status, 'running'), lt(jobRuns.startedAt, startedAt)))
    .returning({ date: jobRuns.date });
  for (const run of stopped) errors.push(`The daily job of ${run.date} was stopped before finishing.`);
  await deps.db.insert(jobRuns).values({ id, job: 'daily', date, startedAt, finishedAt: startedAt, status: 'running', households: 0, errors });

  // Light, global upkeep. A failure here is reported, and the night's syncs still run.
  const upkeep: [string, () => Promise<unknown>][] = [
    ['FX rates', () => ensureFx(deps, addDays(date, -7), date)],
    ['cache', () => cachePrune(deps)],
    ['logs', () => pruneLogs(deps)],
    ['jobs', () => pruneJobsStatement(deps)],
    ['sessions', () => deps.db.delete(sessions).where(lt(sessions.expiresAt, startedAt))],
    // Jobs whose wake-up was lost since yesterday.
    ['sweep', () => sweep(deps)],
  ];
  for (const [name, step] of upkeep) {
    try {
      await step();
    } catch (error) {
      errors.push(`${name}: ${describeError(error)}`);
    }
  }

  const rows = await deps.db.select({ id: households.id }).from(households);
  const entries: [Tenant, JobSpec][] = [];
  for (const { id: householdId } of rows) {
    const tenant = new Tenant(deps.db, householdId);
    const syncs = `${nightlyGroup(id)}:${householdId}`;
    const active = await activeConnections(tenant);
    for (const connection of active) {
      entries.push([
        tenant,
        { id: `${syncs}:sync:${connection.id}`, type: 'sync', payload: { connectionId: connection.id, trigger: 'nightly' }, connectionId: connection.id, groupId: syncs },
      ]);
    }
    entries.push([
      tenant,
      {
        id: `${syncs}:snapshot`,
        type: 'snapshot',
        payload: { date, trigger: 'nightly' },
        groupId: nightlyGroup(id),
        waitsFor: active.length > 0 ? syncs : null,
      },
    ]);
  }
  if (rows.length > 0) {
    // Recorded on the first household (jobs belong to one); it reads every household's jobs.
    entries.push([new Tenant(deps.db, rows[0].id), { id: `${nightlyGroup(id)}:finish`, type: 'nightly_finish', payload: { runId: id }, waitsFor: nightlyGroup(id) }]);
  }
  await deps.db.update(jobRuns).set({ households: rows.length, errors }).where(eq(jobRuns.id, id));
  // All at once, so no household's snapshot can finish before the others exist.
  await enqueueForHouseholds(deps, entries);
  if (rows.length === 0) await finishNightly(deps, id);
  return { id, date, households: rows.length };
}

/**
 * Complete a night's job_runs row: the cron's own errors plus every job of the
 * night that failed (after its retries).
 */
export async function finishNightly(deps: Deps, runId: string): Promise<void> {
  const [run] = await deps.db.select().from(jobRuns).where(eq(jobRuns.id, runId));
  if (!run) return;
  const failed = await deps.db
    .select({ type: jobs.type, connectionId: jobs.connectionId, householdId: jobs.householdId, errorMessage: jobs.errorMessage })
    .from(jobs)
    .where(and(eq(jobs.status, 'failed'), or(eq(jobs.groupId, nightlyGroup(runId)), like(jobs.groupId, `${nightlyGroup(runId)}:%`))));
  const errors = [
    ...run.errors,
    ...failed.map((job) => `${job.type} ${job.connectionId ?? job.householdId}: ${job.errorMessage ?? 'failed'}`),
  ];
  if (errors.length > 0) console.error('Daily job errors', errors);
  await deps.db
    .update(jobRuns)
    .set({ finishedAt: deps.now().getTime(), status: errors.length > 0 ? 'errors' : 'ok', errors })
    .where(and(eq(jobRuns.id, runId), inArray(jobRuns.status, ['running'])));
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
    const stopped = job.status === 'interrupted' || (job.status === 'running' && now - job.startedAt > NIGHTLY_MAX_MS);
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
  // Background jobs that failed for good (after their retries).
  const failedJobs = (
    await tenant.db
      .select({ type: jobs.type, connectionId: jobs.connectionId, finishedAt: jobs.finishedAt, errorCode: jobs.errorCode, attempts: jobs.attempts })
      .from(jobs)
      .where(tenant.scope(jobs, eq(jobs.status, 'failed'), gte(jobs.finishedAt, now - SHOW_INTERRUPTED_MS)))
      .orderBy(desc(jobs.finishedAt))
      .limit(10)
  ).map((job) => ({
    ...job,
    finishedAt: job.finishedAt ?? now,
    institutionName: job.connectionId ? (names.get(job.connectionId) ?? 'A login') : null,
  }));
  return { nightly, interrupted, failedJobs };
}
