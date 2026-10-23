import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { meteredD1, type D1Like } from '../server/adapters/d1Meter';
import * as schema from '../server/db/schema';
import { runJobWith } from '../server/services/jobRunner';
import { enqueue } from '../server/services/jobRunner';
import { Tenant } from '../server/db/tenant';
import { rowsWrittenToday } from '../server/services/writeBudget';
import { brokerage, marketData } from './brokerage';
import type { Deps } from '../server/ports';
import { client, createHousehold, createTestDeps, dbStats, flush, settle, TODAY } from './helpers';

/** Linking the realistic login and running its whole load takes a few seconds on a slow CI runner. */
const SLOW = 30_000;

/** The realistic brokerage login linked, its rows written counted as D1 would (index entries included). */
async function linked(budget: number, run: (deps: Deps) => Promise<void> = (deps) => settle(deps, 20)) {
  const plaid = brokerage();
  const { prices, fx } = marketData();
  const deps = await createTestDeps({ plaid, prices, fx });
  deps.config.dailyWriteBudget = budget;
  deps.writes = { rowsWritten: () => dbStats(deps).d1RowsWritten };
  const home = await createHousehold(deps, 'Home', 'me@example.com');
  await client(deps, home.cookie)('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'investments' } });
  const start = deps.now().getTime();
  await run(deps);
  // The history before the link day, by account name and ticker (ids differ
  // between databases). The link day's own row is the snapshot's, taken on
  // whichever day the load finishes.
  const rows = async () => {
    const names = new Map((await deps.db.select().from(schema.accounts)).map((row) => [row.id, row.name]));
    const tickers = new Map((await deps.db.select().from(schema.securities)).map((row) => [row.id, row.ticker]));
    const upTo = <T extends { date: string }>(list: T[]) => list.filter((row) => row.date < TODAY);
    return {
      accounts: upTo(await deps.db.select().from(schema.accountDaily)).map((row) => `${names.get(row.accountId)}:${row.date}:${row.balance}:${row.source}`).sort(),
      holdings: upTo(await deps.db.select().from(schema.holdingDaily)).map((row) => `${names.get(row.accountId)}:${tickers.get(row.securityId)}:${row.date}:${row.value}`).sort(),
    };
  };
  return { deps, start, rows, api: client(deps, home.cookie) };
}

describe('daily write budget', () => {
  it('spreads a history load over days at the budget, with the same result and no attempts used', async () => {
    const unlimited = await linked(0);
    const budgeted = await linked(40_000);
    // The same history in the end...
    expect(await budgeted.rows()).toEqual(await unlimited.rows());
    // ...over more than one day (UTC), none failed, and waiting used no attempts.
    expect(budgeted.deps.now().getTime() - budgeted.start).toBeGreaterThan(24 * 3600_000);
    const jobs = await budgeted.deps.db.select().from(schema.jobs);
    expect(jobs.filter((job) => job.status !== 'done')).toEqual([]);
    expect(Math.max(...jobs.map((job) => job.attempts))).toBe(1);
    expect(new Set(jobs.map((job) => new Date(job.finishedAt!).toISOString().slice(0, 10))).size).toBeGreaterThan(1);
    // Each day stayed within the budget (plus one job's worth).
    const days = await budgeted.deps.db.select().from(schema.dbUsage);
    expect(days.length).toBeGreaterThan(1);
    for (const day of days) expect(day.rowsWritten).toBeLessThanOrEqual(40_000 + 4_000);
    // Without a budget, nothing waited.
    expect(unlimited.deps.now().getTime()).toBe(unlimited.start);
  }, SLOW);

  it('meanwhile, the waiting jobs say why and are due just after midnight UTC', async () => {
    const { deps, api } = await linked(40_000, flush);
    const waiting = (await deps.db.select().from(schema.jobs)).filter((job) => job.status === 'queued');
    expect(waiting.length).toBeGreaterThan(0);
    for (const job of waiting) {
      expect(job.errorMessage).toMatch(/^Waiting for tomorrow \(UTC\): [\d,]+ of today's 40,000 database writes used\.$/);
      expect(new Date(job.runAfter).toISOString()).toBe('2026-10-10T00:02:00.000Z');
    }
    expect(await rowsWrittenToday(deps)).toBeLessThanOrEqual(40_000);
    // The login says so.
    const [login] = (await api('/api/connections')).body.connections;
    expect(login.historyProgress).toMatchObject({ waitingUntil: Date.parse('2026-10-10T00:02:00Z') });
    expect(login.historyProgress.done).toBeLessThan(login.historyProgress.total);
  }, SLOW);

  it("waits for midnight UTC when D1 says its daily limit is reached, without using an attempt", async () => {
    const deps = await createTestDeps();
    const home = await createHousehold(deps, 'Home', 'me@example.com');
    const tenant = new Tenant(deps.db, home.householdId);
    await enqueue(deps, tenant, [{ id: 'j1', type: 'snapshot', payload: {} }]);
    const handlers = { snapshot: async () => { throw new Error('D1_ERROR: Exceeded daily limit of rows written'); } } as never;
    await runJobWith(deps, 'j1', handlers);
    const [job] = await deps.db.select().from(schema.jobs).where(eq(schema.jobs.id, 'j1'));
    expect(job).toMatchObject({ status: 'queued', attempts: 0 });
    // 2026-10-09T02:00Z now: just after the next midnight UTC.
    expect(new Date(job.runAfter).toISOString()).toBe('2026-10-10T00:02:00.000Z');
  });

  it('counts what a request or job wrote towards the day', async () => {
    const deps = await createTestDeps();
    let written = 0;
    deps.writes = { rowsWritten: () => written };
    const home = await createHousehold(deps, 'Home', 'me@example.com');
    const tenant = new Tenant(deps.db, home.householdId);
    await enqueue(deps, tenant, [{ id: 'j1', type: 'snapshot', payload: {} }]);
    await runJobWith(deps, 'j1', { snapshot: async () => { written += 250; return {}; } } as never);
    expect(await rowsWrittenToday(deps)).toBe(250);
  });
});

describe('D1 write meter', () => {
  it("adds up rows_written from run(), all() and batch() results, passing D1's own statements to batch()", async () => {
    const batched: unknown[] = [];
    class Statement {
      readonly rows: number;
      constructor(rows: number) {
        this.rows = rows;
      }
      bind() {
        return this;
      }
      async run() {
        return { meta: { rows_written: this.rows } };
      }
      async all() {
        return { results: [], meta: { rows_written: this.rows } };
      }
      async raw() {
        return [];
      }
    }
    const d1: D1Like = {
      prepare: (query) => new Statement(query.length),
      batch: async (statements) => {
        batched.push(...statements);
        return statements.map((statement) => ({ meta: { rows_written: (statement as unknown as Statement).rows } }));
      },
    };
    const { db, meter } = meteredD1(d1);
    await db.prepare('xx').bind(1).run(); // 2
    await db.prepare('xxx').all(); // 3
    await (db.prepare('x') as unknown as Statement).raw(); // no meta: 0
    await db.batch([db.prepare('xxxx'), db.prepare('xxxxx').bind(2)]); // 4 + 5
    expect(meter.rowsWritten()).toBe(14);
    expect(batched.every((statement) => statement instanceof Statement)).toBe(true);
  });
});
