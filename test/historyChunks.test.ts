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
import { account, closes, fakePlaid, fakePrices, holding, security } from './fakes';
import { client, createHousehold, createTestDeps, flush } from './helpers';

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
