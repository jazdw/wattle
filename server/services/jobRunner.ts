/**
 * Background work as small jobs, recorded in the `jobs` table. Each job runs
 * in its own invocation (a Cloudflare Queue message on Workers, the process's
 * own loop on Node), so it has the platform's limits to itself, and is
 * retried when it fails or is stopped part-way.
 *
 * Running a job (runJobWith):
 *  1. Claim it: one conditional update takes a job that's queued and due, or
 *     one still marked running whose lock ran out (that attempt was stopped
 *     part-way). The claim counts the attempt and sets a fresh lock.
 *  2. Run its handler, which renews the lock before each write (like a lease:
 *     an attempt that lost its lock stops without writing).
 *  3. Done, or failed: queued again after a backoff, until max_attempts. A
 *     handler can ask to run later (RetryLater) without using an attempt.
 *  4. If it was the last unfinished job of its group, queue the jobs waiting
 *     for that group.
 *
 * The sweep wakes jobs whose wake-up was lost (overdue, or locked by an
 * attempt that was stopped) and releases waiting jobs whose group finished
 * without releasing them. It runs nightly and whenever the app checks
 * /api/status, so nothing relies on the queue keeping its messages.
 */
import { and, eq, inArray, isNotNull, lt, lte, or, sql } from 'drizzle-orm';
import { runAtomic } from '../db/batch';
import { jobs, type JOB_TYPES } from '../db/schema';
import { Tenant } from '../db/tenant';
import { describeError } from '../lib/errors';
import type { Deps } from '../ports';
import { INTERRUPTED, INTERRUPTED_MESSAGE } from './activity';
import { LEASE_MS, LeaseLostError } from './lease';

export type JobType = (typeof JOB_TYPES)[number];
export type JobRow = typeof jobs.$inferSelect;

/** Waits before retrying a failed attempt: 1, 5, then 30 minutes. */
const BACKOFF_SECONDS = [60, 300, 1800];
/** A queued job this long overdue lost its wake-up. */
const OVERDUE_MS = 2 * 60 * 1000;
/** Finished jobs are kept this long (the Activity log keeps what they did). */
const RETENTION_MS = 30 * 24 * 3600 * 1000;
const UNFINISHED = ['waiting', 'queued', 'running'] as const;

export interface JobSpec {
  /** A fixed id makes adding the same job twice add it once. */
  id?: string;
  type: JobType;
  payload: Record<string, unknown>;
  connectionId?: string | null;
  groupId?: string | null;
  /**
   * Wait until this group has no unfinished jobs. Add the group's jobs in the
   * same call (or earlier): one added after the group has finished doesn't
   * hold back what was already released.
   */
  waitsFor?: string | null;
  /** Not before (epoch ms). */
  runAfter?: number;
  maxAttempts?: number;
}

/** Asked by a handler: run again after `seconds`, without counting this as an attempt. */
export class RetryLater extends Error {
  readonly seconds: number;
  constructor(seconds: number, reason: string) {
    super(reason);
    this.name = 'RetryLater';
    this.seconds = seconds;
  }
}

/** Another attempt took the job over (this one's lock ran out): stop without writing. */
export class JobLostError extends Error {
  constructor(id: string) {
    super(`Lost the lock on job ${id}; another attempt took over.`);
    this.name = 'JobLostError';
  }
}

export interface JobContext {
  deps: Deps;
  tenant: Tenant;
  job: JobRow;
  /** Confirm this attempt still holds the job and extend its lock. Call right before writing. */
  renew(): Promise<void>;
}

export type JobHandler = (context: JobContext) => Promise<Record<string, unknown> | void>;
export type JobHandlers = Record<JobType, JobHandler>;
/**
 * Called once a job has failed for good (out of attempts, or stopped part-way
 * every time), to record that where people will see it. Best effort.
 */
export type FailureHandler = (context: JobContext, error: { code: string | null; message: string }) => Promise<void>;
export type FailureHandlers = Partial<Record<JobType, FailureHandler>>;

/** What the caller of a run should do with the wake-up: nothing, or try again after a while. */
export interface JobOutcome {
  /** The job couldn't run yet (not due, or another attempt holds it). */
  retryInSeconds?: number;
}

/** Add jobs for a household (insert-or-ignore) and wake a runner for those that can run. */
export async function enqueue(deps: Deps, tenant: Tenant, specs: JobSpec[]): Promise<string[]> {
  return enqueueForHouseholds(
    deps,
    specs.map((spec) => [tenant, spec]),
  );
}

/** Add jobs for several households in one atomic batch, then wake a runner for those that can run. */
export async function enqueueForHouseholds(deps: Deps, entries: [Tenant, JobSpec][]): Promise<string[]> {
  if (entries.length === 0) return [];
  const now = deps.now().getTime();
  const rows = entries.map(([tenant, spec]) => ({
    id: spec.id ?? crypto.randomUUID(),
    householdId: tenant.householdId,
    connectionId: spec.connectionId ?? null,
    type: spec.type,
    payload: spec.payload,
    groupId: spec.groupId ?? null,
    waitsFor: spec.waitsFor ?? null,
    status: spec.waitsFor ? ('waiting' as const) : ('queued' as const),
    maxAttempts: spec.maxAttempts ?? 3,
    runAfter: spec.runAfter ?? now,
    createdAt: now,
  }));
  // One statement per job (19 columns allow only five rows per insert anyway), all or none.
  await runAtomic(deps.db, rows.map((row) => deps.db.insert(jobs).values(row).onConflictDoNothing()));
  await wakeQueued(deps, rows.filter((row) => row.status === 'queued'));
  // The group may have finished while these were being added (its last job's
  // release ran before they existed): check now. Whichever of the two runs
  // second sees both, so a waiting job is never left behind.
  await releaseWaiting(deps, rows.flatMap((row) => (row.waitsFor ? [row.waitsFor] : [])));
  return rows.map((row) => row.id);
}

async function wakeQueued(deps: Deps, rows: { id: string; runAfter: number }[]): Promise<void> {
  const now = deps.now().getTime();
  const due = rows.filter((row) => row.runAfter <= now).map((row) => row.id);
  if (due.length > 0) await deps.jobQueue.wake(due);
  for (const row of rows.filter((candidate) => candidate.runAfter > now)) {
    await deps.jobQueue.wake([row.id], Math.ceil((row.runAfter - now) / 1000));
  }
}

/** Run one job by id with these handlers. Never throws for the job's own failure. */
export async function runJobWith(deps: Deps, id: string, handlers: JobHandlers, onFailed: FailureHandlers = {}): Promise<JobOutcome> {
  const now = deps.now().getTime();
  const token = crypto.randomUUID();
  const claim = (condition: ReturnType<typeof and>) =>
    deps.db
      .update(jobs)
      .set({ status: 'running', attempts: sql`${jobs.attempts} + 1`, lockToken: token, lockedUntil: now + LEASE_MS, startedAt: now })
      .where(and(eq(jobs.id, id), condition))
      .returning();
  let [job] = await claim(and(eq(jobs.status, 'queued'), lte(jobs.runAfter, now)));
  let resumed = false;
  if (!job) {
    // Still marked running, but its lock ran out: that attempt was stopped part-way.
    [job] = await claim(and(eq(jobs.status, 'running'), lt(jobs.lockedUntil, now)));
    resumed = Boolean(job);
  }
  if (!job) {
    const [current] = await deps.db.select().from(jobs).where(eq(jobs.id, id));
    if (current?.status === 'running' && current.lockedUntil) return { retryInSeconds: Math.max(1, Math.ceil((current.lockedUntil - now) / 1000)) };
    if (current?.status === 'queued') return { retryInSeconds: Math.max(1, Math.ceil((current.runAfter - now) / 1000)) };
    return {};
  }
  const tenant = new Tenant(deps.db, job.householdId);
  const mine = and(eq(jobs.id, id), eq(jobs.lockToken, token));
  const failedForGood = async (errorCode: string | null, errorMessage: string) => {
    console.error(`Job ${job.type} failed`, errorMessage);
    await finish(deps, job, mine, { status: 'failed', errorCode, errorMessage });
    try {
      await onFailed[job.type]?.(context, { code: errorCode, message: errorMessage });
    } catch (error) {
      console.error(`Recording the failed ${job.type} job failed`, describeError(error));
    }
  };

  const context: JobContext = {
    deps,
    tenant,
    job,
    renew: async () => {
      const renewed = await deps.db
        .update(jobs)
        .set({ lockedUntil: deps.now().getTime() + LEASE_MS })
        .where(mine)
        .returning({ id: jobs.id });
      if (renewed.length === 0) throw new JobLostError(id);
    },
  };
  if (resumed && job.attempts > job.maxAttempts) {
    await failedForGood(INTERRUPTED, INTERRUPTED_MESSAGE);
    return {};
  }
  try {
    const result = await handlers[job.type](context);
    await finish(deps, job, mine, { status: 'done', result: result ?? null, errorCode: null, errorMessage: null });
  } catch (error) {
    if (error instanceof JobLostError) return {};
    // Asked to wait, or another run took the connection's lease mid-way: not a failed attempt.
    const later = error instanceof RetryLater ? error : error instanceof LeaseLostError ? new RetryLater(30, error.message) : null;
    if (later) {
      const runAfter = deps.now().getTime() + later.seconds * 1000;
      await deps.db
        .update(jobs)
        .set({ status: 'queued', attempts: sql`${jobs.attempts} - 1`, runAfter, lockToken: null, lockedUntil: null, errorMessage: later.message })
        .where(mine);
      await deps.jobQueue.wake([id], later.seconds);
      return {};
    }
    const message = describeError(error).slice(0, 500);
    const code = (error as { code?: unknown }).code;
    const errorCode = typeof code === 'string' ? code : null;
    if (job.attempts < job.maxAttempts) {
      const delay = BACKOFF_SECONDS[Math.min(job.attempts - 1, BACKOFF_SECONDS.length - 1)];
      await deps.db
        .update(jobs)
        .set({ status: 'queued', runAfter: deps.now().getTime() + delay * 1000, lockToken: null, lockedUntil: null, errorCode, errorMessage: message })
        .where(mine);
      await deps.jobQueue.wake([id], delay);
    } else {
      await failedForGood(errorCode, message);
    }
  }
  return {};
}

/** Record the job's end, then release what waits for its group. */
async function finish(
  deps: Deps,
  job: JobRow,
  mine: ReturnType<typeof and>,
  values: Pick<Partial<JobRow>, 'status' | 'result' | 'errorCode' | 'errorMessage'>,
): Promise<void> {
  await deps.db
    .update(jobs)
    .set({ ...values, finishedAt: deps.now().getTime(), lockToken: null, lockedUntil: null })
    .where(mine);
  if (job.groupId) await releaseWaiting(deps, [job.groupId]);
}

/**
 * Queue the jobs waiting for these groups, where the group has no unfinished
 * jobs left. One statement per group, so two jobs finishing at once release
 * them once; safe to repeat.
 */
async function releaseWaiting(deps: Deps, groups: string[]): Promise<void> {
  const now = deps.now().getTime();
  for (const group of new Set(groups)) {
    const released = await deps.db
      .update(jobs)
      .set({ status: 'queued', runAfter: now })
      .where(
        and(
          eq(jobs.status, 'waiting'),
          eq(jobs.waitsFor, group),
          sql`not exists (select 1 from ${jobs} as others where others.group_id = ${group} and others.status in ('waiting', 'queued', 'running'))`,
        ),
      )
      .returning({ id: jobs.id });
    if (released.length > 0) await deps.jobQueue.wake(released.map((row) => row.id));
  }
}

/**
 * Recover lost wake-ups (all households): queued jobs well overdue, jobs
 * locked by an attempt that was stopped part-way, and waiting jobs whose
 * group finished without releasing them. Returns how many were woken.
 */
export async function sweep(deps: Deps): Promise<number> {
  const now = deps.now().getTime();
  const stuck = await deps.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      or(
        and(eq(jobs.status, 'queued'), lt(jobs.runAfter, now - OVERDUE_MS)),
        and(eq(jobs.status, 'running'), lt(jobs.lockedUntil, now)),
      ),
    )
    .limit(500);
  if (stuck.length > 0) await deps.jobQueue.wake(stuck.map((row) => row.id));
  const waiting = await deps.db
    .selectDistinct({ group: jobs.waitsFor })
    .from(jobs)
    .where(and(eq(jobs.status, 'waiting'), isNotNull(jobs.waitsFor)))
    .limit(500);
  await releaseWaiting(
    deps,
    waiting.flatMap((row) => (row.group ? [row.group] : [])),
  );
  return stuck.length;
}

/** Ids of jobs that can run now (Node's loop and tests pick them up this way). */
export async function dueJobs(deps: Deps, limit = 50): Promise<string[]> {
  const now = deps.now().getTime();
  const rows = await deps.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(or(and(eq(jobs.status, 'queued'), lte(jobs.runAfter, now)), and(eq(jobs.status, 'running'), lt(jobs.lockedUntil, now))))
    .orderBy(jobs.runAfter, jobs.createdAt)
    .limit(limit);
  return rows.map((row) => row.id);
}

/** A group's jobs that haven't finished. */
export async function unfinishedIn(tenant: Tenant, group: string): Promise<number> {
  const [row] = await tenant.db
    .select({ count: sql<number>`count(*)` })
    .from(jobs)
    .where(tenant.scope(jobs, eq(jobs.groupId, group), inArray(jobs.status, [...UNFINISHED])));
  return row?.count ?? 0;
}

/** Delete finished jobs older than the retention period (all households; daily job). */
export function pruneJobsStatement(deps: Deps) {
  return deps.db.delete(jobs).where(and(inArray(jobs.status, ['done', 'failed']), lt(jobs.finishedAt, deps.now().getTime() - RETENTION_MS)));
}
