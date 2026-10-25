/**
 * Work budgets: how many database calls, rows written and outside requests
 * the main operations make with realistically sized data: each request, and
 * each background job (each runs in an invocation of its own). Workers count
 * these per invocation (Free: 50 outside requests, 1,000 to Cloudflare
 * services; D1 Free: 100,000 rows written a day), and the work behind them
 * (mostly building statements) is most of the CPU time. Counts, not timings,
 * so the tests are exact: a change that adds a query per row, or a request
 * per ticker, fails here before it reaches production.
 *
 * Budgets are today's counts plus headroom. If a change needs more, raise
 * the budget deliberately, with the reason.
 */
import { describe, expect, it } from 'vitest';
import type { Deps } from '../server/ports';
import { eq } from 'drizzle-orm';
import * as schema from '../server/db/schema';
import { runJob } from '../server/services/jobHandlers';
import { runDaily } from '../server/services/jobs';
import { brokerage, marketData } from './brokerage';
import { client, createHousehold, createTestDeps, dbStats, runDueJobs } from './helpers';

/** Work done by `operation`: database calls, statements, rows written, outside requests. */
async function measure(deps: Deps, outside: () => number, operation: () => Promise<unknown>) {
  const before = dbStats(deps);
  const requestsBefore = outside();
  await operation();
  const after = dbStats(deps);
  return {
    dbCalls: after.calls - before.calls,
    statements: after.statements - before.statements,
    rowsWritten: after.rowsWritten - before.rowsWritten,
    d1RowsWritten: after.d1RowsWritten - before.d1RowsWritten,
    outside: outside() - requestsBefore,
  };
}

type Work = Awaited<ReturnType<typeof measure>>;

/** Run due jobs one at a time, measuring each (each runs in its own invocation on Workers). */
async function measureJobs(deps: Deps, outside: () => number) {
  const jobs: (Work & { type: string })[] = [];
  await runDueJobs(deps, async (id) => {
    const [row] = await deps.db.select({ type: schema.jobs.type }).from(schema.jobs).where(eq(schema.jobs.id, id));
    jobs.push({ type: row.type, ...(await measure(deps, outside, () => runJob(deps, id))) });
  });
  return jobs;
}

const largest = (jobs: Work[], key: keyof Work) => Math.max(0, ...jobs.map((job) => job[key]));
const total = (jobs: Work[], key: keyof Work) => jobs.reduce((sum, job) => sum + job[key], 0);

async function linkedBrokerage() {
  const plaid = brokerage();
  const { prices, fx } = marketData();
  const deps = await createTestDeps({ plaid, prices, fx });
  const home = await createHousehold(deps, 'Home', 'me@example.com');
  const api = client(deps, home.cookie);
  const outside = () => plaid.state.requests + prices.calls.length + fx.calls.length;
  // The link request itself (the first sync), then its background jobs.
  const request = await measure(deps, outside, async () => {
    expect((await api('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'investments' } })).status).toBe(200);
  });
  const jobs = await measureJobs(deps, outside);
  return { deps, api, plaid, outside, request, jobs };
}

/** Measured (2026-10-21) → budget. */
describe('work budgets (2 accounts, 30 positions, 500 transactions, 2 years)', () => {
  it('first link: the request, and each of its background jobs', async () => {
    const { request, jobs } = await linkedBrokerage();
    expect(request.outside).toBeLessThanOrEqual(8); // 6
    expect(request.dbCalls).toBeLessThanOrEqual(25); // 18

    // Every job fits an invocation of its own: well under Workers Free's 50
    // outside requests, and about JOB_CHUNK_ROWS (1,000) rows built.
    expect(largest(jobs, 'outside')).toBeLessThanOrEqual(8); // 6
    expect(largest(jobs, 'dbCalls')).toBeLessThanOrEqual(25); // 19
    // Statements are built one by one (Drizzle): the main CPU cost.
    expect(largest(jobs, 'statements')).toBeLessThanOrEqual(150); // 119
    expect(largest(jobs, 'rowsWritten')).toBeLessThanOrEqual(1_400); // 1,081
    // The whole load: two years of daily rows per position (D1 Free allows
    // 100,000 rows written a day, indexes counting too), and one Tiingo
    // history request per ticker.
    expect(total(jobs, 'rowsWritten')).toBeLessThanOrEqual(60_000); // 46,318
    // As D1 counts it, index entries included: over the Free plan's daily
    // 100,000 for one login like this.
    expect(total(jobs, 'd1RowsWritten')).toBeLessThanOrEqual(130_000); // 116,806
    expect(largest(jobs, 'd1RowsWritten')).toBeLessThanOrEqual(4_000); // 3,247
    expect(total(jobs, 'outside')).toBeLessThanOrEqual(45); // 37
    expect(jobs.length).toBeLessThanOrEqual(70); // 57
  });

  it('the nightly job', async () => {
    const { deps, outside } = await linkedBrokerage();
    const later = deps.now().getTime() + 86400_000;
    deps.now = () => new Date(later);
    const cron = await measure(deps, outside, () => runDaily(deps));
    const jobs = await measureJobs(deps, outside);
    // The cron only does upkeep and adds the night's jobs.
    expect(cron.outside).toBeLessThanOrEqual(2); // 1
    expect(cron.dbCalls).toBeLessThanOrEqual(22); // 19
    // A sync, a snapshot and the finish, each in its own invocation.
    expect(jobs.map((job) => job.type).sort()).toEqual(['nightly_finish', 'snapshot', 'sync']);
    expect(largest(jobs, 'outside')).toBeLessThanOrEqual(5); // 3
    expect(largest(jobs, 'dbCalls')).toBeLessThanOrEqual(33); // 26
    expect(largest(jobs, 'statements')).toBeLessThanOrEqual(170); // 137
    expect(total(jobs, 'rowsWritten')).toBeLessThanOrEqual(220); // 165
  });

  it('page loads', async () => {
    const { deps, api, outside } = await linkedBrokerage();
    // Database calls per page (measured in the comment).
    const budgets: Record<string, number> = {
      '/api/portfolio': 14, // 11
      '/api/accounts': 8, // 6
      '/api/connections': 3, // 2
      '/api/history?range=2Y&group=total': 13, // 10
      '/api/history?range=2Y&group=category': 10, // 8
      '/api/quotes': 4, // 3
      '/api/status': 9, // 7, with the job sweep
      '/api/activity': 7, // 6: runs, snapshots, nightly runs, failed jobs
    };
    for (const [path, budget] of Object.entries(budgets)) {
      const page = await measure(deps, outside, async () => expect((await api(path)).status).toBe(200));
      expect(page.dbCalls, path).toBeLessThanOrEqual(budget);
      expect(page.outside, path).toBeLessThanOrEqual(1); // at most the day's FX rate
    }
  });
});
