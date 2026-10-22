/**
 * Work budgets: how many database calls, rows written and outside requests
 * the main operations make with realistically sized data. Workers count
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
import type { InvestmentTransaction } from 'plaid';
import type { Deps } from '../server/ports';
import { runDaily } from '../server/services/jobs';
import { account, closes, fakeFx, fakePlaid, fakePrices, holding, security } from './fakes';
import { client, createHousehold, createTestDeps, dbStats, flush } from './helpers';

const ETFS = Array.from({ length: 25 }, (_, index) => `E${String(index).padStart(2, '0')}`);
const FUNDS = ['FNDAX', 'FNDBX', 'FNDCX', 'FNDDX', 'FNDEX'];
const TICKERS = [...ETFS, ...FUNDS];
const HISTORY_START = '2024-09-01';

/** A brokerage login: 2 accounts, 30 positions (25 ETFs, 5 mutual funds), 500 buys over two years. */
function brokerage() {
  const securities = TICKERS.map((ticker) => security(`s-${ticker}`, ticker, FUNDS.includes(ticker) ? 'mutual fund' : 'etf', 100));
  const accountFor = (index: number) => (index < 18 ? 'brk1' : 'brk2');
  const transactions = Array.from({ length: 500 }, (_, index) => {
    const date = new Date(Date.UTC(2024, 9, 10) + Math.floor((index * 720) / 500) * 86400_000).toISOString().slice(0, 10);
    const ticker = TICKERS[index % TICKERS.length];
    return {
      investment_transaction_id: `t${index}`,
      account_id: accountFor(TICKERS.indexOf(ticker)),
      security_id: `s-${ticker}`,
      date,
      name: `Buy ${ticker}`,
      type: 'buy',
      subtype: 'buy',
      quantity: 1,
      amount: 100,
      price: 100,
      fees: 0,
      iso_currency_code: 'USD',
    } as Partial<InvestmentTransaction>;
  });
  const plaid = fakePlaid({
    accounts: [account('brk1', 'investment', 180_000), account('brk2', 'investment', 120_000)],
    securities,
    holdings: TICKERS.map((ticker, index) => holding(accountFor(index), `s-${ticker}`, 100, 100)),
    transactions: transactions as never,
  });
  plaid.state.transactionsPageSize = 500;
  return plaid;
}

function marketData() {
  const series = Object.fromEntries(TICKERS.map((ticker) => [ticker, closes(HISTORY_START, 800, 100, 0.01)]));
  const latest = Object.fromEntries(ETFS.map((ticker) => [ticker, series[ticker].at(-1)!]));
  return { prices: fakePrices(series, latest), fx: fakeFx() };
}

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
    outside: outside() - requestsBefore,
  };
}

async function linkedBrokerage() {
  const plaid = brokerage();
  const { prices, fx } = marketData();
  const deps = await createTestDeps({ plaid, prices, fx });
  const home = await createHousehold(deps, 'Home', 'me@example.com');
  const api = client(deps, home.cookie);
  const outside = () => plaid.state.requests + prices.calls.length + fx.calls.length;
  const link = await measure(deps, outside, async () => {
    expect((await api('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'investments' } })).status).toBe(200);
    await flush(deps); // the history load and snapshot run after the response, in the same invocation
  });
  return { deps, api, plaid, outside, link };
}

/** Measured (2026-10-21) → budget. */
describe('work budgets (2 accounts, 30 positions, 500 transactions, 2 years)', () => {
  it('first link, with its history load', async () => {
    const { link } = await linkedBrokerage();
    // 37 requests: Plaid ~7, one Tiingo history request per ticker. Workers Free stops at 50.
    expect(link.outside).toBeLessThanOrEqual(45);
    expect(link.dbCalls).toBeLessThanOrEqual(140); // 113
    // Statements are built one by one (Drizzle), the main CPU cost: 3,587.
    expect(link.statements).toBeLessThanOrEqual(4_500);
    // 46,691: two years of daily rows per position. D1 Free allows 100,000 a day (indexes count too).
    expect(link.rowsWritten).toBeLessThanOrEqual(60_000);
  });

  it('the nightly job', async () => {
    const { deps, outside } = await linkedBrokerage();
    const later = deps.now().getTime() + 86400_000;
    deps.now = () => new Date(later);
    const nightly = await measure(deps, outside, () => runDaily(deps));
    expect(nightly.outside).toBeLessThanOrEqual(8); // 5
    expect(nightly.dbCalls).toBeLessThanOrEqual(70); // 55
    expect(nightly.statements).toBeLessThanOrEqual(220); // 176
    expect(nightly.rowsWritten).toBeLessThanOrEqual(200); // 158
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
      '/api/status': 5, // 4
      '/api/activity': 5, // 4
    };
    for (const [path, budget] of Object.entries(budgets)) {
      const page = await measure(deps, outside, async () => expect((await api(path)).status).toBe(200));
      expect(page.dbCalls, path).toBeLessThanOrEqual(budget);
      expect(page.outside, path).toBeLessThanOrEqual(1); // at most the day's FX rate
    }
  });
});
