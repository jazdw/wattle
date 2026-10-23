/** Test harness: the real app on in-memory SQLite (libsql) with fake providers. */
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createApp } from '../server/app';
import { createSession } from '../server/auth/routes';
import * as schema from '../server/db/schema';
import type { Deps, Db } from '../server/ports';
import { runJob, runNextJob } from '../server/services/jobHandlers';
import { runDaily } from '../server/services/jobs';
import { dueJobs } from '../server/services/jobRunner';

export const ORIGIN = 'http://localhost';
export const TEST_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, index) => index)));

/** D1's limit; libsql allows far more, so the test client enforces it. */
const D1_MAX_PARAMS = 100;

function checkParams(statement: unknown): void {
  const args = (statement as { args?: unknown[] | Record<string, unknown> })?.args;
  const count = Array.isArray(args) ? args.length : args ? Object.keys(args).length : 0;
  if (count > D1_MAX_PARAMS) throw new Error(`Statement binds ${count} parameters; D1 allows ${D1_MAX_PARAMS}.`);
}

/**
 * Database work, as D1 would count it: each execute or batch is one call (a
 * request to D1 from the Worker), each statement in it a query, and rows
 * changed by inserts, updates and deletes are rows written. D1 also counts a
 * row written for each index entry a write changes (`d1RowsWritten`: each
 * changed row times one plus the table's indexes, an upper bound for updates
 * that leave indexed columns alone). Composite primary keys are an index too.
 */
export interface DbStats {
  calls: number;
  statements: number;
  rowsWritten: number;
  d1RowsWritten: number;
}

const WRITE_TARGET = /^\s*(?:insert(?:\s+or\s+\w+)?\s+into|update|delete\s+from)\s+["`]?(\w+)/i;

function sqlOf(statement: unknown): string {
  return typeof statement === 'string' ? statement : ((statement as { sql?: string })?.sql ?? '');
}

const dbStatsByDeps = new WeakMap<Deps, DbStats>();

/** The database work done through `deps` so far (since it was created, excluding migrations). */
export function dbStats(deps: Deps): DbStats {
  return { ...dbStatsByDeps.get(deps)! };
}

export async function createTestDeps(overrides: Partial<Deps> = {}): Promise<Deps> {
  const client = createClient({ url: ':memory:' });
  const execute = client.execute.bind(client);
  const batch = client.batch.bind(client);
  const stats: DbStats = { calls: 0, statements: 0, rowsWritten: 0, d1RowsWritten: 0 };
  // Indexes per table (filled after migrating).
  const indexes = new Map<string, number>();
  const count = (statement: unknown, rows: number) => {
    stats.rowsWritten += rows;
    const table = WRITE_TARGET.exec(sqlOf(statement))?.[1];
    stats.d1RowsWritten += rows * (1 + (table ? (indexes.get(table) ?? 0) : 0));
  };
  client.execute = (async (statement: Parameters<typeof execute>[0]) => {
    checkParams(statement);
    const result = await execute(statement);
    stats.calls += 1;
    stats.statements += 1;
    count(statement, result.rowsAffected);
    return result;
  }) as typeof client.execute;
  client.batch = (async (statements: Parameters<typeof batch>[0], mode?: Parameters<typeof batch>[1]) => {
    for (const statement of statements) checkParams(statement);
    const results = await batch(statements, mode);
    stats.calls += 1;
    stats.statements += statements.length;
    results.forEach((result, index) => count(statements[index], result.rowsAffected));
    return results;
  }) as typeof client.batch;
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: 'migrations' });
  for (const row of (await execute("select tbl_name, count(*) as n from sqlite_master where type = 'index' group by tbl_name")).rows) {
    indexes.set(String(row.tbl_name), Number(row.n));
  }
  Object.assign(stats, { calls: 0, statements: 0, rowsWritten: 0, d1RowsWritten: 0 });
  const wakes: { ids: string[]; delaySeconds?: number }[] = [];
  const deps: Deps = {
    db: db as unknown as Db,
    config: { devLoginEmails: [], quoteCacheSeconds: 300, tokenEncKey: TEST_KEY, plaidAllowRemove: false, jobChunkRows: 1_000 },
    plaid: null,
    prices: null,
    quotes: null,
    fx: null,
    now: () => new Date('2026-10-09T02:00:00Z'),
    sleep: async () => {},
    // Wake-ups are recorded; tests run due jobs with flush() (or runDueJobs).
    jobQueue: {
      wake: async (ids, delaySeconds) => {
        wakes.push({ ids, delaySeconds });
      },
    },
    ...overrides,
  };
  wakesByDeps.set(deps, wakes);
  dbStatsByDeps.set(deps, stats);
  return deps;
}

const wakesByDeps = new WeakMap<Deps, { ids: string[]; delaySeconds?: number }[]>();

/** The runner wake-ups `deps` asked for so far. */
export function wakes(deps: Deps): { ids: string[]; delaySeconds?: number }[] {
  return [...(wakesByDeps.get(deps) ?? [])];
}

/** Run jobs that are due now, including those they add or release, until none is left, each by `run` (to measure one job at a time). */
export async function runDueJobs(deps: Deps, run: (id: string) => Promise<unknown> = (id) => runJob(deps, id)): Promise<number> {
  let ran = 0;
  for (let round = 0; round < 1_000; round += 1) {
    const ids = await dueJobs(deps);
    if (ids.length === 0) return ran;
    for (const id of ids) {
      await run(id);
      ran += 1;
    }
  }
  throw new Error('Jobs kept becoming due: a job that never settles?');
}

/**
 * Run jobs until none is left, moving the clock forward to each retry
 * (backoffs, RetryLater) as needed, at most `maxWaits` times.
 */
export async function settle(deps: Deps, maxWaits = 10): Promise<void> {
  await flush(deps);
  for (let wait = 0; wait < maxWaits; wait += 1) {
    const [next] = await deps.db
      .select({ runAfter: schema.jobs.runAfter })
      .from(schema.jobs)
      .where(eq(schema.jobs.status, 'queued'))
      .orderBy(schema.jobs.runAfter)
      .limit(1);
    if (!next) return;
    const at = Math.max(next.runAfter, deps.now().getTime());
    deps.now = () => new Date(at);
    await flush(deps);
  }
}

/** The nightly cron, then every job it adds (with their retries); returns the night's job_runs row. */
export async function nightly(deps: Deps) {
  const report = await runDaily(deps);
  await settle(deps);
  const [run] = await deps.db.select().from(schema.jobRuns).where(eq(schema.jobRuns.id, report.id));
  return run;
}

/** Finish background work: run every due job (and the ones they add or release), fairest first, as the runners do. */
export async function flush(deps: Deps): Promise<void> {
  for (let ran = 0; ran < 5_000; ran += 1) {
    if (!(await runNextJob(deps)).claimed) return;
  }
  throw new Error('Jobs kept becoming due: a job that never settles?');
}

/** Today's market date for the fixed test clock (2026-10-08 in New York). */
export const TODAY = '2026-10-08';

export async function createHousehold(deps: Deps, name: string, email: string) {
  const householdId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const now = Date.now();
  await deps.db.insert(schema.households).values({ id: householdId, name, createdAt: now });
  await deps.db.insert(schema.users).values({ id: userId, googleSub: `sub-${userId}`, email, name: email, createdAt: now });
  await deps.db.insert(schema.householdMembers).values({ householdId, userId, role: 'owner', createdAt: now });
  await deps.db.insert(schema.allowedEmails).values({ email, householdId, addedAt: now }).onConflictDoNothing();
  const token = await createSession(deps, userId);
  return { householdId, userId, cookie: `wt_session=${token}` };
}

export interface TestResponse {
  status: number;
  // oxlint-disable-next-line typescript/no-explicit-any -- test convenience
  body: any;
  headers: Headers;
}

/**
 * Calls the real app as a browser on ORIGIN would: same-origin `Origin` on
 * writes (override with `headers`), optional session cookie, JSON bodies.
 */
export function client(deps: Deps, cookie?: string, origin = ORIGIN) {
  const app = createApp();
  return async (path: string, init: RequestInit & { json?: unknown } = {}): Promise<TestResponse> => {
    const headers = new Headers(init.headers);
    if (cookie && !headers.has('cookie')) headers.set('cookie', cookie);
    let body = init.body;
    if (init.json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(init.json);
    }
    if (init.method && init.method !== 'GET' && !headers.has('origin')) headers.set('origin', origin);
    const response = await app.request(`${origin}${path}`, { ...init, headers, body }, { deps });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed, headers: response.headers };
  };
}
