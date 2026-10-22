/**
 * History built as many small jobs must be exactly the history built at once:
 * the same rows, for a first load, a rebuild after a late transaction, and a
 * fill of days the syncs missed.
 */
import { eq } from 'drizzle-orm';
import type { InvestmentTransaction } from 'plaid';
import { describe, expect, it } from 'vitest';
import * as schema from '../server/db/schema';
import { Tenant } from '../server/db/tenant';
import { runJob } from '../server/services/jobHandlers';
import { snapshotHousehold } from '../server/services/snapshots';
import { syncConnection } from '../server/services/sync';
import { marketDate } from '../shared/dates';
import { ProviderHttpError } from '../server/adapters/marketData';
import { account, closes, fakePlaid, fakePrices, holding, security } from './fakes';
import { client, createHousehold, createTestDeps, flush, settle } from './helpers';

const buy = (id: string, accountId: string, securityId: string, date: string, quantity: number, price: number) =>
  ({
    investment_transaction_id: id,
    account_id: accountId,
    security_id: securityId,
    date,
    name: 'Buy',
    type: 'buy',
    subtype: 'buy',
    quantity,
    amount: quantity * price,
    price,
    fees: 0,
    iso_currency_code: 'USD',
  }) as Partial<InvestmentTransaction>;

/** Link a two-account brokerage, then a rebuild and a missed-day fill; returns every history row, comparably. */
async function scenario(jobChunkRows: number) {
  const plaid = fakePlaid({
    accounts: [account('brk', 'investment', 3000), account('ira', 'investment', 2000)],
    securities: [security('s-vti', 'VTI', 'etf', 100), security('s-bnd', 'BND', 'etf', 70), security('s-fund', 'PLANFUND', 'mutual fund', null), security('s-cash', 'CUR:USD', 'cash', 1)],
    holdings: [holding('brk', 's-vti', 20, 100), holding('brk', 's-cash', 400, 1), holding('ira', 's-bnd', 15, 70), holding('ira', 's-fund', 30, 20)],
    transactions: [
      buy('t1', 'brk', 's-vti', '2026-09-01', 5, 95),
      buy('t2', 'brk', 's-vti', '2026-03-15', 10, 80),
      buy('t3', 'ira', 's-bnd', '2025-12-01', 15, 68),
      buy('t4', 'ira', 's-fund', '2025-06-10', 40, 15), // more than held now, sold later: clamped before
      buy('t5', 'ira', 's-fund', '2026-02-02', -10, 18),
    ] as never,
  });
  const prices = fakePrices({ VTI: closes('2024-09-01', 800, 60, 0.05), BND: closes('2024-09-01', 800, 65, 0.01) });
  const deps = await createTestDeps({ plaid, prices });
  deps.config.jobChunkRows = jobChunkRows;
  const home = await createHousehold(deps, 'Home', 'me@example.com');
  const tenant = new Tenant(deps.db, home.householdId);
  await client(deps, home.cookie)('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'investments' } });
  await flush(deps);
  const [connection] = await deps.db.select().from(schema.connections);
  const blocks = async () => (await deps.db.select().from(schema.jobs).where(eq(schema.jobs.type, 'history_block'))).length;
  const afterLoad = await blocks();

  // A transaction dated before the history arrives late: a rebuild.
  plaid.state.transactions.push(buy('late', 'brk', 's-vti', '2025-11-20', 2, 75) as never);
  plaid.state.holdings = [holding('brk', 's-vti', 22, 100), holding('brk', 's-cash', 400, 1), holding('ira', 's-bnd', 15, 70), holding('ira', 's-fund', 30, 20)];
  await syncConnection(deps, tenant, connection.id, 'manual');
  await flush(deps);

  // Two nights the syncs fail, then one that fills them in.
  const start = deps.now().getTime();
  const night = async (n: number) => {
    deps.now = () => new Date(start + n * 86400_000);
    await syncConnection(deps, tenant, connection.id, 'nightly').catch(() => {});
    await flush(deps);
    await snapshotHousehold(deps, tenant, marketDate(new Date(deps.now().getTime() - 5 * 3600_000)));
  };
  const working = plaid.getHoldings;
  plaid.getHoldings = async () => {
    throw new Error('network down');
  };
  await night(1);
  await night(2);
  plaid.getHoldings = working;
  plaid.state.transactions.push(buy('t6', 'brk', 's-vti', marketDate(new Date(start + 86400_000)), 3, 101) as never);
  plaid.state.holdings[0] = holding('brk', 's-vti', 25, 100);
  await night(3);

  const accountsById = new Map((await deps.db.select().from(schema.accounts)).map((row) => [row.id, row.externalId]));
  const tickers = new Map((await deps.db.select().from(schema.securities)).map((row) => [row.id, row.ticker]));
  const accountRows = (await deps.db.select().from(schema.accountDaily))
    .map((row) => [accountsById.get(row.accountId), row.date, row.balance, row.source, row.estimated].join('|'))
    .sort();
  const holdingRows = (await deps.db.select().from(schema.holdingDaily))
    .map((row) => [accountsById.get(row.accountId), tickers.get(row.securityId), row.date, row.quantity, row.price, row.value, row.source, row.estimated].join('|'))
    .sort();
  const runs = (await deps.db.select().from(schema.syncRuns).where(eq(schema.syncRuns.action, 'history'))).map((run) => run.outcome);
  return { accountRows, holdingRows, runs, blocks: { afterLoad, total: await blocks() } };
}

describe('history in jobs', () => {
  it('writes the same rows in many small jobs as in one per account', async () => {
    const small = await scenario(50);
    const large = await scenario(100_000);
    expect(large.blocks.afterLoad).toBe(2); // one per account
    expect(small.blocks.afterLoad).toBeGreaterThan(40);
    expect(small.runs).toEqual(['ok', 'ok', 'ok']); // load, rebuild, missed days
    expect(large.runs).toEqual(['ok', 'ok', 'ok']);
    expect(small.accountRows.length).toBeGreaterThan(700);
    expect(small.holdingRows.length).toBeGreaterThan(1500);
    expect(small.accountRows).toEqual(large.accountRows);
    expect(small.holdingRows).toEqual(large.holdingRows);
  });
});

describe('history progress', () => {
  it("shows on the login while its parts run, and clears when they're done", async () => {
    const plaid = fakePlaid({
      accounts: [account('brk', 'investment', 3000)],
      securities: [security('s-vti', 'VTI', 'etf', 100)],
      holdings: [holding('brk', 's-vti', 20, 100)],
      transactions: [buy('t1', 'brk', 's-vti', '2026-03-15', 10, 80)] as never,
    });
    const deps = await createTestDeps({ plaid, prices: fakePrices({ VTI: closes('2024-09-01', 800, 60, 0.05) }) });
    deps.config.jobChunkRows = 50;
    const home = await createHousehold(deps, 'Home', 'me@example.com');
    const api = client(deps, home.cookie);
    await api('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'investments' } });
    const progress = async () => (await api('/api/connections')).body.connections[0].historyProgress;
    const run = async (type: string) => {
      const [job] = await deps.db.select().from(schema.jobs).where(eq(schema.jobs.type, type as 'history_plan'));
      await runJob(deps, job.id);
    };
    expect(await progress()).toBeNull(); // not planned yet
    await run('history_plan');
    const planned = await progress();
    expect(planned.done).toBe(0);
    expect(planned.total).toBeGreaterThan(10); // one price job, many blocks
    await run('history_prices');
    expect(await progress()).toEqual({ done: 1, total: planned.total });
    await flush(deps);
    expect(await progress()).toBeNull();
    // Another household sees none of it.
    const other = await createHousehold(deps, 'Other', 'other@example.com');
    expect((await client(deps, other.cookie)('/api/connections')).body.connections).toEqual([]);
  });
});

describe('history prices', () => {
  async function linked(failure: () => Error | null) {
    const plaid = fakePlaid({
      accounts: [account('brk', 'investment', 3000)],
      securities: [security('s-vti', 'VTI', 'etf', 100), security('s-bnd', 'BND', 'etf', 70)],
      holdings: [holding('brk', 's-vti', 20, 100), holding('brk', 's-bnd', 10, 70)],
      transactions: [buy('t1', 'brk', 's-vti', '2026-03-15', 10, 80)] as never,
    });
    const prices = fakePrices({ VTI: closes('2024-09-01', 800, 60, 0.05), BND: closes('2024-09-01', 800, 65, 0.01) });
    const working = prices.dailyCloses;
    prices.dailyCloses = async (ticker, start, end) => {
      const error = ticker === 'VTI' ? failure() : null;
      if (error) throw error;
      return working(ticker, start, end);
    };
    const deps = await createTestDeps({ plaid, prices });
    const home = await createHousehold(deps, 'Home', 'me@example.com');
    const api = client(deps, home.cookie);
    await api('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'investments' } });
    const state = async () => {
      const [connection] = await deps.db.select().from(schema.connections);
      const runs = await deps.db.select().from(schema.syncRuns).where(eq(schema.syncRuns.action, 'history'));
      const backfilled = await deps.db.select().from(schema.holdingDaily).where(eq(schema.holdingDaily.source, 'backfill'));
      const priceJobs = await deps.db.select().from(schema.jobs).where(eq(schema.jobs.type, 'history_prices'));
      return { connection, runs, backfilled, priceJobs };
    };
    return { deps, api, state };
  }

  it("fails the load, writing nothing, when a ticker's prices can't be fetched; Reload history then builds it", async () => {
    let down = true;
    const { deps, api, state } = await linked(() => (down ? new Error('Tiingo HTTP 500') : null));
    await settle(deps);
    const failed = await state();
    expect(failed.priceJobs.find((job) => (job.payload.tickers as string[]).includes('VTI'))).toMatchObject({ status: 'failed', attempts: 3, errorCode: 'PRICES_UNAVAILABLE' });
    expect(failed.connection.backfillStatus).toBe('failed'); // offers Reload history
    expect(failed.runs).toHaveLength(1);
    expect(failed.runs[0]).toMatchObject({ outcome: 'error', errorCode: 'PRICES_UNAVAILABLE' });
    expect(failed.backfilled).toEqual([]); // no history estimated without VTI's closes

    down = false;
    expect((await api(`/api/connections/${failed.connection.id}/backfill`, { method: 'POST' })).body.queued).toBe(true);
    await settle(deps);
    const rebuilt = await state();
    expect(rebuilt.connection.backfillStatus).toBe('done');
    expect(rebuilt.runs.map((run) => run.outcome).sort()).toEqual(['error', 'ok']);
    expect(rebuilt.backfilled.length).toBeGreaterThan(700);
    expect(rebuilt.backfilled.every((row) => !row.estimated)).toBe(true);
  });

  it('waits out a rate limit without using up attempts', async () => {
    let limited = 2;
    const { deps, state } = await linked(() => (limited-- > 0 ? new ProviderHttpError('Tiingo VTI', 429) : null));
    await flush(deps);
    const waiting = (await state()).priceJobs.find((job) => (job.payload.tickers as string[]).includes('VTI'))!;
    expect(waiting).toMatchObject({ status: 'queued', attempts: 0 });
    expect(waiting.runAfter - deps.now().getTime()).toBe(30 * 60 * 1000);
    await settle(deps);
    const done = await state();
    expect(done.connection.backfillStatus).toBe('done');
    expect(done.runs[0]).toMatchObject({ outcome: 'ok' });
    expect(done.backfilled.every((row) => !row.estimated)).toBe(true);
  });
});

describe('missed days', () => {
  it('a fill that failed is found again by a later sync, not before the retry wait, and then fills every carried day', async () => {
    const plaid = fakePlaid({
      accounts: [account('brk', 'investment', 3000)],
      securities: [security('s-vti', 'VTI', 'etf', 100)],
      holdings: [holding('brk', 's-vti', 30, 100)],
      transactions: [buy('t1', 'brk', 's-vti', '2026-03-15', 10, 80)] as never,
    });
    const prices = fakePrices({ VTI: closes('2024-09-01', 1100, 60, 0.05) });
    const working = prices.dailyCloses;
    let pricesDown = false;
    prices.dailyCloses = async (ticker, start, end) => {
      if (pricesDown) throw new Error('Tiingo HTTP 500');
      return working(ticker, start, end);
    };
    const deps = await createTestDeps({ plaid, prices });
    const home = await createHousehold(deps, 'Home', 'me@example.com');
    const tenant = new Tenant(deps.db, home.householdId);
    await client(deps, home.cookie)('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'investments' } });
    await settle(deps);
    const [connection] = await deps.db.select().from(schema.connections);
    expect(connection.backfillStatus).toBe('done');

    const start = deps.now().getTime();
    const at = (ms: number) => (deps.now = () => new Date(ms));
    const snapshot = () => snapshotHousehold(deps, tenant, marketDate(new Date(deps.now().getTime() - 5 * 3600_000)));
    const carried = async () =>
      (await deps.db.select().from(schema.accountDaily).where(eq(schema.accountDaily.source, 'sync'))).filter((row) => row.estimated).length;
    const plans = async () => (await deps.db.select().from(schema.jobs).where(eq(schema.jobs.type, 'history_plan'))).length;
    const sync = async () => {
      await syncConnection(deps, tenant, connection.id, 'manual');
      await settle(deps);
    };

    // 120 nights the syncs fail (and the price provider is down): each snapshot carries the balance forward.
    pricesDown = true;
    const workingHoldings = plaid.getHoldings;
    plaid.getHoldings = async () => {
      throw new Error('network down');
    };
    for (let night = 1; night <= 120; night += 1) {
      at(start + night * 86400_000);
      await syncConnection(deps, tenant, connection.id, 'nightly').catch(() => {});
      await snapshot();
    }
    plaid.getHoldings = workingHoldings;
    expect(await carried()).toBeGreaterThan(100);

    // The sync works again, but the fill's prices don't: it fails, writing nothing.
    at(start + 121 * 86400_000);
    await sync();
    await snapshot(); // a known figure after the gap
    const failedRun = (await deps.db.select().from(schema.syncRuns).where(eq(schema.syncRuns.action, 'history'))).at(-1)!;
    expect(failedRun).toMatchObject({ outcome: 'error', errorCode: 'PRICES_UNAVAILABLE' });
    expect(await carried()).toBeGreaterThan(100);
    const [afterFailure] = await deps.db.select().from(schema.connections);
    expect(afterFailure.missedRetryAt).toBeGreaterThan(deps.now().getTime());

    // An hour later: not tried again yet.
    pricesDown = false;
    const before = await plans();
    at(deps.now().getTime() + 3600_000);
    await sync();
    expect(await plans()).toBe(before);

    // After the wait, a sync finds the carried days (though a known day follows them) and fills them all.
    at(deps.now().getTime() + 6 * 3600_000);
    await sync();
    expect(await plans()).toBe(before + 1);
    expect(await carried()).toBe(0);
    const filled = (await deps.db.select().from(schema.syncRuns).where(eq(schema.syncRuns.action, 'history'))).at(-1)!;
    expect(filled).toMatchObject({ outcome: 'ok' });
    const [done] = await deps.db.select().from(schema.connections);
    expect(done.missedRetryAt).toBeNull();
  });
});
