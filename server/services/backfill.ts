/**
 * A connection's history, built by background jobs (./jobRunner). A login can
 * have both:
 *  - with Investments: investment accounts rebuilt from investment
 *    transactions + daily closes (./backfillCore);
 *  - with Assets: the other accounts' Plaid Asset Report `historical_balances`
 *    (up to 731 days), requested here and collected later (./assetReports).
 *
 * A history load (linking, Reload history), a rebuild (a late transaction) and
 * a fill of days the syncs missed all run as:
 *   history_plan    decide the work; ask for the asset report; for a rebuild,
 *                   drop the previous estimate
 *   history_prices  daily closes for a few tickers each (Tiingo)
 *   history_block   one investment account, one window of days each, sized to
 *                   about JOB_CHUNK_ROWS rows
 *   history_finish  record the outcome; queue today's snapshot
 * Blocks wait for the prices, and the finish for the blocks. Backfilled rows
 * never overwrite synced, imported or manual rows, and every job can run
 * again safely.
 */
import { and, eq, gte, inArray, isNull, lt, max, min, notLike, or, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { addDays, dateRange, marketDate, type IsoDate } from '../../shared/dates';
import { PlaidApiError } from '../adapters/plaid';
import { chunkRows, inChunks, runAtomic, runBatch } from '../db/batch';
import { accountDaily, accounts, connections, holdingDaily, holdings, investmentTransactions, jobs, securities, syncRuns } from '../db/schema';
import type { Tenant } from '../db/tenant';
import type { Deps } from '../ports';
import { reconstructHistory } from './backfillCore';
import { completeRunStatements, SyncRun, type SyncTrigger } from './activity';
import { encryptToken, loadTokenKeys, tokenAad } from './crypto';
import { enqueue, RetryLater, type JobContext, type JobSpec, type JobType } from './jobRunner';
import { queueReportCollection } from './assetReports';
import { closeLookup, ensureCloses, ensureFx } from './pricing';
import { connectionLease, Lease } from './lease';
import { accessTokenFor, getConnection, HISTORY_DAYS, isActive, type ConnectionRow } from './sync';
import { isCashSecurity, priceOn } from './valuation';

/** A first load (or Reload history), a rebuild after a late transaction, or days the syncs missed. */
export type HistoryMode = 'load' | 'rebuild' | 'missed';

interface PlanPayload {
  connectionId: string;
  mode: HistoryMode;
  trigger: SyncTrigger;
  webhookUrl: string | null;
  runId: string;
  /** A load for some accounts only (added with Choose accounts): their investment history, and a bank report only if asked for. */
  only?: HistoryScope;
}

export interface HistoryScope {
  accountIds: string[];
  bankReport: boolean;
}

interface PricesPayload {
  tickers: string[];
  start: IsoDate;
  end: IsoDate;
}

interface BlockPayload {
  connectionId: string;
  runId: string;
  accountId: string;
  mode: HistoryMode;
  /** The rebuild walks from `end` back to `start`... */
  start: IsoDate;
  end: IsoDate;
  /** ...and writes the days from `from` to `to`. */
  from: IsoDate;
  to: IsoDate;
}

interface FinishPayload {
  connectionId: string;
  mode: HistoryMode;
  runId: string;
  startedAt: number;
  reportRequested: boolean;
}

const HISTORY_JOBS: JobType[] = ['history_plan', 'history_prices', 'history_block', 'history_finish'];
/** About how many daily closes one ticker's two years add (trading days). */
const CLOSES_PER_TICKER = 520;
/** Price jobs stay well under Workers Free's 50 outside requests per invocation. */
const MAX_TICKERS_PER_JOB = 40;
/** Closes looked up before a block's first day, to carry a price over holidays and gaps. */
const PRICE_LOOKBACK_DAYS = 21;
/** A busy connection (a sync running) is tried again after this. */
const BUSY_RETRY_SECONDS = 30;
/** After a fill of missed days fails, the next waits this long. */
const MISSED_RETRY_MS = 6 * 3600 * 1000;
/** A requested asset report is first looked for after this (Plaid takes from seconds to minutes). */
const REPORT_FIRST_CHECK_SECONDS = 60;
/** A rate-limited price provider (Tiingo allows 50 requests an hour) is asked again after this... */
const RATE_LIMITED_RETRY_SECONDS = 30 * 60;
/** ...for at most this long before the price job fails. */
const RATE_LIMITED_GIVE_UP_MS = 24 * 3600 * 1000;

const pricesGroup = (runId: string) => `history:${runId}:prices`;
const blocksGroup = (runId: string) => `history:${runId}:blocks`;

function backfillStatusStatement(tenant: Tenant, connectionId: string, status: ConnectionRow['backfillStatus']) {
  return tenant.db
    .update(connections)
    .set({ backfillStatus: status })
    .where(tenant.scope(connections, eq(connections.id, connectionId)));
}

/** After a fill of missed days: wait before the next if it failed (its days stay carried forward), else none. */
export function missedRetryStatement(deps: Deps, tenant: Tenant, connectionId: string, failed: boolean) {
  return tenant.db
    .update(connections)
    .set({ missedRetryAt: failed ? deps.now().getTime() + MISSED_RETRY_MS : null })
    .where(tenant.scope(connections, eq(connections.id, connectionId)));
}

/** A history job of this connection is queued, waiting or running (other than run `except`'s, whose ids start history:<run>:). */
async function historyUnderway(tenant: Tenant, connectionId: string, except?: string): Promise<boolean> {
  const [row] = await tenant.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      tenant.scope(
        jobs,
        eq(jobs.connectionId, connectionId),
        inArray(jobs.type, HISTORY_JOBS),
        inArray(jobs.status, ['waiting', 'queued', 'running']),
        ...(except ? [notLike(jobs.id, `history:${except}:%`)] : []),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Queue a history load, rebuild or missed-day fill, unless one is underway.
 * `webhookUrl` is where Plaid reports a finished asset report (from the
 * request origin, so no hostname is configured).
 */
export async function queueHistory(
  deps: Deps,
  tenant: Tenant,
  connectionId: string,
  mode: HistoryMode,
  trigger: SyncTrigger,
  webhookUrl: string | null = null,
  only?: HistoryScope,
): Promise<boolean> {
  if (await historyUnderway(tenant, connectionId)) return false;
  const runId = crypto.randomUUID();
  const payload: PlanPayload = { connectionId, mode, trigger, webhookUrl, runId, ...(only ? { only } : {}) };
  await enqueue(deps, tenant, [{ id: `history:${runId}:plan`, type: 'history_plan', payload: { ...payload }, connectionId }]);
  return true;
}

/**
 * Progress of the history loads underway, by connection: of their price and
 * block jobs, how many have finished. A load whose plan hasn't run yet shows
 * as 0 of 0, so a page that asked for it sees it underway straight away.
 */
export async function historyProgress(tenant: Tenant): Promise<Map<string, { done: number; total: number }>> {
  const underway = await tenant.db
    .selectDistinct({ type: jobs.type, groupId: jobs.groupId, connectionId: jobs.connectionId })
    .from(jobs)
    .where(tenant.scope(jobs, inArray(jobs.type, ['history_plan', 'history_prices', 'history_block']), inArray(jobs.status, ['waiting', 'queued', 'running'])));
  const progress = new Map<string, { done: number; total: number }>();
  for (const row of underway) if (row.type === 'history_plan' && row.connectionId) progress.set(row.connectionId, { done: 0, total: 0 });
  // A load's price and block groups share its run id: history:<run>:prices / :blocks.
  const runs = new Set(underway.flatMap((row) => (row.type !== 'history_plan' && row.groupId ? [row.groupId.split(':').slice(0, 2).join(':')] : [])));
  if (runs.size === 0) return progress;
  const parts = await tenant.db
    .select({ connectionId: jobs.connectionId, groupId: jobs.groupId, status: jobs.status })
    .from(jobs)
    .where(tenant.scope(jobs, inArray(jobs.type, ['history_prices', 'history_block']), inArray(jobs.groupId, [...runs].flatMap((run) => [`${run}:prices`, `${run}:blocks`]))));
  for (const part of parts) {
    if (!part.connectionId) continue;
    const entry = progress.get(part.connectionId) ?? { done: 0, total: 0 };
    entry.total += 1;
    if (part.status === 'done' || part.status === 'failed') entry.done += 1;
    progress.set(part.connectionId, entry);
  }
  return progress;
}

/**
 * A history load is due: never run; abandoned part-way ("running" with no
 * report outstanding and no jobs underway); or invalidated by a late
 * transaction.
 */
function historyDue(connection: ConnectionRow): HistoryMode | null {
  if (connection.backfillStatus === 'pending') return 'load';
  if (connection.backfillStatus === 'running' && connection.assetReportTokenEnc === null) return 'load';
  if (connection.hasInvestments && connection.historyStaleAt !== null && connection.backfillStatus === 'done') return 'rebuild';
  return null;
}

/**
 * After a sync: queue the history work it found due, a load or rebuild, or a
 * fill of days the syncs missed (not before the first load is in, nor while
 * a report is outstanding).
 */
export async function queueDueHistory(deps: Deps, tenant: Tenant, connectionId: string, trigger: SyncTrigger): Promise<void> {
  const connection = await getConnection(tenant, connectionId);
  if (!connection || !isActive(connection) || (await historyUnderway(tenant, connectionId))) return;
  const due = historyDue(connection);
  if (due) {
    await queueHistory(deps, tenant, connectionId, due, trigger);
    return;
  }
  if (connection.status !== 'ok' || connection.backfillStatus !== 'done' || connection.assetReportTokenEnc) return;
  // A fill that failed is tried again later, not on every sync (webhooks bring several a day).
  if (connection.missedRetryAt !== null && connection.missedRetryAt > deps.now().getTime()) return;
  if (await missedDays(tenant, connection, marketDate(deps.now()))) await queueHistory(deps, tenant, connectionId, 'missed', trigger);
}

/** Days per block for an account holding about `positions` securities. */
function daysPerBlock(deps: Deps, positions: number): number {
  return Math.min(731, Math.max(7, Math.floor(deps.config.jobChunkRows / Math.max(1, positions))));
}

/** [from, to] windows covering start..end, newest first, `size` days each. */
function windows(start: IsoDate, end: IsoDate, size: number): [IsoDate, IsoDate][] {
  const result: [IsoDate, IsoDate][] = [];
  for (let to = end; to >= start; to = addDays(to, -size)) {
    const from = addDays(to, -(size - 1));
    result.push([from < start ? start : from, to]);
  }
  return result;
}

/** The securities an account held from `start` on: today's holdings plus any it traded. */
async function involvedSecurities(tenant: Tenant, accountId: string, start: IsoDate): Promise<string[]> {
  const held = await tenant.db.select({ id: holdings.securityId }).from(holdings).where(tenant.scope(holdings, eq(holdings.accountId, accountId)));
  const traded = await tenant.db
    .selectDistinct({ id: investmentTransactions.securityId })
    .from(investmentTransactions)
    .where(tenant.scope(investmentTransactions, eq(investmentTransactions.accountId, accountId), gte(investmentTransactions.date, start)));
  return [...new Set([...held.map((row) => row.id), ...traded.flatMap((row) => (row.id ? [row.id] : []))])];
}

/**
 * history_plan: decide the work and queue it. Holds the connection's lease
 * while it asks for the asset report and (for a rebuild) drops the previous
 * estimate, so a sync can't run in between.
 */
export async function planHistory({ deps, tenant, job, renew }: JobContext): Promise<Record<string, unknown>> {
  const plan = job.payload as unknown as PlanPayload;
  const found = await getConnection(tenant, plan.connectionId);
  if (!found || !isActive(found)) return { skipped: 'not syncing' };
  // Often queued by a sync still finishing: wait a moment for its lease.
  const lease = await Lease.acquireWaiting(deps, tenant, connectionLease(found.id));
  if (!lease) throw new RetryLater(BUSY_RETRY_SECONDS, 'The connection is busy.');
  try {
    // Read again under the lease (a sync or another plan may have just changed it).
    const connection = await getConnection(tenant, found.id);
    if (!connection || !isActive(connection)) return { skipped: 'not syncing' };
    // Two plans queued at the same moment: the second finds the first's jobs (added under this lease) and stands down.
    if (await historyUnderway(tenant, connection.id, plan.runId)) return { skipped: 'another history run is underway' };
    const startedAt = deps.now().getTime();
    const today = marketDate(deps.now());
    const run = new SyncRun(deps, tenant, connection.id, 'history', plan.trigger, plan.runId);
    const outcome: BatchItem<'sqlite'>[] = [];
    // Investment accounts to rebuild, each from its first day.
    let investments: { accountId: string; from: IsoDate }[] = [];
    let reportRequested = false;

    if (plan.mode === 'missed') {
      const missed = await missedDays(tenant, connection, today);
      if (!missed) return { skipped: 'nothing missed' };
      run.note = `Filling days missed since ${missed.from}.`;
      await run.begin();
      if (missed.bankFrom && !connection.assetReportTokenEnc) {
        const report = await requestBalanceHistory(deps, tenant, connection, null, run, Math.min(731, dateRange(missed.bankFrom, today).length));
        outcome.push(...report.statements);
        reportRequested = report.requested;
      }
      investments = missed.investments;
    } else {
      if (plan.only) run.note = plan.only.bankReport ? 'History for newly added accounts.' : 'History for newly added accounts, without a bank report.';
      await run.begin();
      outcome.push(backfillStatusStatement(tenant, connection.id, 'running'));
      await ensureFx(deps, addDays(today, -HISTORY_DAYS), today);
      // Two years, asked for on the first load (not again if this plan is running a second time).
      if (plan.mode === 'load' && connection.hasBalanceHistory && (plan.only?.bankReport ?? true) && !connection.assetReportTokenEnc) {
        const report = await requestBalanceHistory(deps, tenant, connection, plan.webhookUrl, run, 731);
        outcome.push(...report.statements);
        reportRequested = report.requested;
      }
      if (connection.hasInvestments) {
        const accountRows = await tenant.db
          .select({ id: accounts.id, type: accounts.type })
          .from(accounts)
          .where(tenant.scope(accounts, eq(accounts.connectionId, connection.id), eq(accounts.isHidden, false)));
        // With Assets, the bank's balance history covers the other accounts.
        const accountIds = accountRows
          .filter((row) => !connection.hasBalanceHistory || row.type === 'investment')
          .filter((row) => !plan.only || plan.only.accountIds.includes(row.id))
          .map((row) => row.id);
        if (plan.mode === 'rebuild' && accountIds.length > 0) {
          // Drop the previous estimate (only backfilled rows; synced, imported
          // and manual ones stay) and reconstruct with every transaction.
          run.note = 'Rebuilt because a transaction dated before the previous history arrived later.';
          outcome.push(
            tenant.db.delete(accountDaily).where(tenant.scope(accountDaily, inArray(accountDaily.accountId, accountIds), eq(accountDaily.source, 'backfill'))),
            tenant.db.delete(holdingDaily).where(tenant.scope(holdingDaily, inArray(holdingDaily.accountId, accountIds), eq(holdingDaily.source, 'backfill'))),
          );
        }
        investments = accountIds.map((accountId) => ({ accountId, from: addDays(today, -HISTORY_DAYS) }));
      }
    }

    // The work: closes for every public ticker involved, then each account in windows.
    const securityRows = await tenant.db
      .select({ id: securities.id, ticker: securities.ticker, isPublic: securities.isPublic })
      .from(securities)
      .where(tenant.scope(securities));
    const tickerOf = new Map(securityRows.flatMap((row) => (row.isPublic && row.ticker ? [[row.id, row.ticker] as const] : [])));
    const tickers = new Set<string>();
    const specs: JobSpec[] = [];
    let earliest: IsoDate = today;
    for (const { accountId, from } of investments) {
      const involved = await involvedSecurities(tenant, accountId, from);
      for (const id of involved) if (tickerOf.has(id)) tickers.add(tickerOf.get(id)!);
      if (from < earliest) earliest = from;
      for (const [blockFrom, blockTo] of windows(from, today, daysPerBlock(deps, involved.length))) {
        const block: BlockPayload = { connectionId: connection.id, runId: plan.runId, accountId, mode: plan.mode, start: from, end: today, from: blockFrom, to: blockTo };
        // Fixed ids: a plan run again (stopped after adding them) adds none twice.
        specs.push({ id: `history:${plan.runId}:block:${accountId}:${blockFrom}`, type: 'history_block', payload: { ...block }, connectionId: connection.id, groupId: blocksGroup(plan.runId) });
      }
    }
    const perJob = Math.min(MAX_TICKERS_PER_JOB, Math.max(1, Math.floor(deps.config.jobChunkRows / CLOSES_PER_TICKER)));
    const tickerList = [...tickers].sort();
    const priceSpecs: JobSpec[] = [];
    for (let index = 0; index < tickerList.length; index += perJob) {
      const prices: PricesPayload = { tickers: tickerList.slice(index, index + perJob), start: earliest, end: today };
      priceSpecs.push({ id: `history:${plan.runId}:prices:${index}`, type: 'history_prices', payload: { ...prices }, connectionId: connection.id, groupId: pricesGroup(plan.runId) });
    }
    if (priceSpecs.length > 0) for (const spec of specs) spec.waitsFor = pricesGroup(plan.runId);
    // A report still outstanding (this plan asked for it on an attempt that was then stopped, or an earlier one did) is waited for too.
    if (connection.assetReportTokenEnc) reportRequested = true;
    const finish: FinishPayload = { connectionId: connection.id, mode: plan.mode, runId: plan.runId, startedAt, reportRequested };
    if (specs.length > 0) run.count('parts', specs.length);

    await renew();
    await lease.renew();
    await runAtomic(tenant.db, [...outcome, run.statement('running')]);
    await enqueue(deps, tenant, [
      ...priceSpecs,
      ...specs,
      {
        id: `history:${plan.runId}:finish`,
        type: 'history_finish',
        payload: { ...finish },
        connectionId: connection.id,
        waitsFor: specs.length > 0 ? blocksGroup(plan.runId) : priceSpecs.length > 0 ? pricesGroup(plan.runId) : null,
      },
    ]);
    // Check for the report without waiting for Plaid's webhook (none reaches a local app) or the next sync.
    if (reportRequested) {
      const latest = await getConnection(tenant, connection.id);
      if (latest) await queueReportCollection(deps, tenant, latest, plan.trigger, REPORT_FIRST_CHECK_SECONDS);
    }
    return { prices: priceSpecs.length, blocks: specs.length, reportRequested };
  } finally {
    await lease.forceRelease();
  }
}

/**
 * history_prices: daily closes for some tickers over the load's days. A
 * ticker that couldn't be fetched fails the attempt (and so is retried):
 * history built without its closes would be estimated, and look right. While
 * the provider is refusing for too many requests, it waits without using up
 * attempts, for up to a day.
 */
export async function historyPrices({ deps, job }: JobContext): Promise<Record<string, unknown>> {
  const { tickers, start, end } = job.payload as unknown as PricesPayload;
  const gaps = await ensureCloses(deps, tickers, start, end);
  if (gaps.failed.length > 0) {
    const message = `Couldn't load prices for ${gaps.failed.join(', ')}.`;
    if (gaps.rateLimited && deps.now().getTime() - job.createdAt < RATE_LIMITED_GIVE_UP_MS) {
      throw new RetryLater(RATE_LIMITED_RETRY_SECONDS, `${message} The price provider is limiting requests; trying again later.`);
    }
    throw Object.assign(new Error(message), { code: 'PRICES_UNAVAILABLE' });
  }
  return { tickers: tickers.length };
}

/** The load's price jobs that failed for good (their tickers' history would only be estimated). */
async function failedPriceJobs(tenant: Tenant, runId: string): Promise<number> {
  const [row] = await tenant.db
    .select({ count: sql<number>`count(*)` })
    .from(jobs)
    .where(tenant.scope(jobs, eq(jobs.groupId, pricesGroup(runId)), eq(jobs.status, 'failed')));
  return row?.count ?? 0;
}

/**
 * history_block: rebuild one investment account's days from `from` to `to`
 * (walking from today's holdings back through its transactions) and write
 * them. A load inserts what's missing; a missed-day fill also replaces the
 * balances carried forward while syncs were missed, in the same batch.
 */
export async function historyBlock({ deps, tenant, job, renew }: JobContext): Promise<Record<string, unknown>> {
  const block = job.payload as unknown as BlockPayload;
  // Without its prices the history would be wrong but look right: write nothing, and the finish fails the load.
  if (await failedPriceJobs(tenant, block.runId)) return { days: 0, skipped: 'prices' };
  const [account] = await tenant.db
    .select()
    .from(accounts)
    .where(tenant.scope(accounts, eq(accounts.id, block.accountId)));
  if (!account || account.isHidden) return { days: 0 };

  const current = await tenant.db
    .select({ securityId: holdings.securityId, quantity: holdings.quantity })
    .from(holdings)
    .where(tenant.scope(holdings, eq(holdings.accountId, account.id)));
  const transactions = await tenant.db
    .select({
      date: investmentTransactions.date,
      securityId: investmentTransactions.securityId,
      quantity: investmentTransactions.quantity,
      amount: investmentTransactions.amount,
    })
    .from(investmentTransactions)
    .where(tenant.scope(investmentTransactions, eq(investmentTransactions.accountId, account.id), gte(investmentTransactions.date, block.start)));
  const involved = new Set([...current.map((row) => row.securityId), ...transactions.flatMap((row) => (row.securityId ? [row.securityId] : []))]);
  const securityRows = [];
  for (const chunk of inChunks([...involved])) {
    securityRows.push(
      ...(await tenant.db
        .select({
          id: securities.id,
          ticker: securities.ticker,
          type: securities.type,
          isPublic: securities.isPublic,
          lastPrice: securities.lastPrice,
          lastPriceDate: securities.lastPriceDate,
        })
        .from(securities)
        .where(tenant.scope(securities, inArray(securities.id, chunk)))),
    );
  }
  const securityById = new Map(securityRows.map((security) => [security.id, security]));
  const tickers = securityRows.flatMap((security) => (security.isPublic && security.ticker ? [security.ticker] : []));
  const closes = await closeLookup(deps, tickers, addDays(block.from, -PRICE_LOOKBACK_DAYS), block.to);
  const cashSecurity = [...involved].find((id) => {
    const security = securityById.get(id);
    return security ? isCashSecurity(security) : false;
  });

  const days = reconstructHistory({
    start: block.start,
    end: block.end,
    emitFrom: block.from,
    emitTo: block.to,
    holdings: current,
    transactions,
    cashSecurityId: cashSecurity ?? null,
    price: (securityId, date) => {
      const security = securityById.get(securityId);
      return security ? priceOn(security, date, closes) : null;
    },
  });
  const holdingRows = days.flatMap((day) =>
    day.positions.map((position) => ({
      householdId: tenant.householdId,
      accountId: account.id,
      securityId: position.securityId,
      date: day.date,
      quantity: position.quantity,
      price: position.price,
      value: position.value,
      currency: account.currency,
      source: 'backfill' as const,
      estimated: position.estimated,
    })),
  );
  const accountRows = days.map((day) => ({
    householdId: tenant.householdId,
    accountId: account.id,
    date: day.date,
    balance: day.total,
    currency: account.currency,
    source: 'backfill' as const,
    estimated: day.estimated,
  }));
  const inserts = [
    ...chunkRows(holdingDaily, holdingRows).map((chunk) => tenant.db.insert(holdingDaily).values(chunk).onConflictDoNothing()),
    ...chunkRows(accountDaily, accountRows).map((chunk) => tenant.db.insert(accountDaily).values(chunk).onConflictDoNothing()),
  ];

  // Written holding the connection's lease, like every change to its data.
  const lease = await Lease.acquireWaiting(deps, tenant, connectionLease(block.connectionId));
  if (!lease) throw new RetryLater(BUSY_RETRY_SECONDS, 'The connection is busy.');
  try {
    await renew();
    await lease.renew();
    if (block.mode !== 'missed') {
      // Today's row comes from the regular snapshot; existing rows stay.
      await runBatch(tenant.db, inserts);
      return { days: accountRows.length };
    }
    // Missed days: the carried-forward snapshot rows give way, with their
    // positions, in the same batch (entered and imported ones stay).
    const carriedRows = carriedForward(tenant, [account.id], block.from, addDays(block.to, 1) < block.end ? addDays(block.to, 1) : block.end);
    const carried = (await tenant.db.select({ date: accountDaily.date }).from(accountDaily).where(carriedRows)).map((row) => row.date);
    await runAtomic(tenant.db, [
      ...(carried.length > 0
        ? [
            tenant.db
              .delete(holdingDaily)
              // By subquery, not a list of dates: D1 allows 100 bound values per statement.
              .where(
                tenant.scope(
                  holdingDaily,
                  eq(holdingDaily.accountId, account.id),
                  eq(holdingDaily.source, 'sync'),
                  inArray(holdingDaily.date, tenant.db.select({ date: accountDaily.date }).from(accountDaily).where(carriedRows)),
                ),
              ),
            tenant.db.delete(accountDaily).where(carriedRows),
          ]
        : []),
      ...inserts,
    ]);
    return { days: accountRows.filter((row) => carried.includes(row.date)).length };
  } finally {
    await lease.forceRelease();
  }
}

/**
 * history_finish: add up the blocks and record the outcome with the run's log
 * entry, atomically. Parts that failed (after their retries), prices or
 * blocks, fail the load, which offers Reload history; a missed-day fill
 * that failed leaves its days carried forward, for a sync after
 * MISSED_RETRY_MS to fill. Then today's snapshot is redone.
 */
export async function finishHistory({ deps, tenant, job, renew }: JobContext): Promise<Record<string, unknown>> {
  const finish = job.payload as unknown as FinishPayload;
  const parts = await tenant.db
    .select({ status: jobs.status, result: jobs.result })
    .from(jobs)
    .where(tenant.scope(jobs, eq(jobs.groupId, blocksGroup(finish.runId))));
  const pricesFailed = await failedPriceJobs(tenant, finish.runId);
  const failed = parts.filter((part) => part.status === 'failed').length + pricesFailed;
  const days = parts.reduce((sum, part) => sum + (Number(part.result?.days) || 0), 0);
  const connection = await getConnection(tenant, finish.connectionId);
  if (!connection) return { days, failed };
  const next = finish.mode === 'missed' ? 'Those days keep their carried-forward balances until a later sync fills them.' : 'Reload history to try again.';
  const error =
    pricesFailed > 0
      ? { code: 'PRICES_UNAVAILABLE', message: `Prices for some of the holdings couldn't be loaded, so no history was written. ${next}` }
      : failed > 0
        ? { code: 'PARTS_FAILED', message: `${failed} of ${parts.length} parts of the history couldn't be built. ${next}` }
        : null;
  const statements: BatchItem<'sqlite'>[] = [];
  if (finish.mode === 'missed') {
    statements.push(missedRetryStatement(deps, tenant, connection.id, failed > 0));
  } else {
    statements.push(
      tenant.db
        .update(connections)
        .set({
          // Still waiting for the bank's report, if one was asked for and it
          // hasn't been collected (or given up, failing the load) meanwhile:
          // checked as this writes.
          backfillStatus:
            failed > 0
              ? 'failed'
              : finish.reportRequested
                ? sql`case when ${connections.assetReportTokenEnc} is not null then 'running' when ${connections.backfillStatus} = 'failed' then 'failed' else 'done' end`
                : connection.hasInvestments
                  ? 'done'
                  : 'skipped',
          ...(connection.hasInvestments ? { historyAsOf: marketDate(deps.now()) } : {}),
          // A late transaction that arrived during this load needs another.
          historyStaleAt: sql`case when ${connections.historyStaleAt} < ${finish.startedAt} then null else ${connections.historyStaleAt} end`,
        })
        .where(tenant.scope(connections, eq(connections.id, connection.id))),
    );
  }
  statements.push(
    ...(await completeRunStatements(deps, tenant, finish.runId, {
      counts: days > 0 ? { days } : {},
      error,
    })),
  );
  await renew();
  await runAtomic(tenant.db, statements);
  await enqueue(deps, tenant, [
    { id: `history:${finish.runId}:snapshot`, type: 'snapshot', payload: { date: marketDate(deps.now()), trigger: 'change' } },
  ]);
  return { days, failed };
}

/**
 * A history plan or finish that failed for good (after its retries, or
 * stopped part-way every time): record it on the run, and for a load mark the
 * history failed, which offers Reload history.
 */
export async function historyFailed({ deps, tenant, job }: JobContext, error: { code: string | null; message: string }): Promise<void> {
  const { connectionId, mode, runId, trigger } = job.payload as unknown as PlanPayload & FinishPayload;
  const [logged] = await tenant.db.select({ id: syncRuns.id }).from(syncRuns).where(tenant.scope(syncRuns, eq(syncRuns.id, runId)));
  const statements: BatchItem<'sqlite'>[] = [];
  if (logged) {
    statements.push(...(await completeRunStatements(deps, tenant, runId, { error })));
  } else {
    // The plan never got as far as logging the run.
    const run = new SyncRun(deps, tenant, connectionId, 'history', trigger ?? 'nightly', runId);
    run.error = { code: error.code, message: error.message.slice(0, 500) };
    statements.push(run.statement());
  }
  statements.push(mode === 'missed' ? missedRetryStatement(deps, tenant, connectionId, true) : backfillStatusStatement(tenant, connectionId, 'failed'));
  await runAtomic(tenant.db, statements);
}

/** Snapshot rows that carried a balance forward because the sync was missed. */
function carriedForward(tenant: Tenant, accountIds: string[], from: IsoDate, before: IsoDate) {
  return tenant.scope(
    accountDaily,
    inArray(accountDaily.accountId, accountIds),
    eq(accountDaily.source, 'sync'),
    eq(accountDaily.estimated, true),
    gte(accountDaily.date, from),
    lt(accountDaily.date, before),
  );
}

/* ------------------------------------------------------------------ */
/* Missed days                                                         */
/* ------------------------------------------------------------------ */

interface MissedDays {
  /** The earliest first missed day. */
  from: IsoDate;
  /** Bank-history accounts' first missed day: ask the bank from then. */
  bankFrom: IsoDate | null;
  /** Investment accounts to rebuild, each from its first missed day. */
  investments: { accountId: string; from: IsoDate }[];
}

/**
 * Days the syncs missed, from the stored balances: per account, the day after
 * the last one the institution's figure covers (a reported balance or bank
 * history). Recorded and imported days don't count: the fill never replaces
 * them, and the bank can still fill the days around them.
 */
export async function missedDays(tenant: Tenant, connection: ConnectionRow, today: IsoDate): Promise<MissedDays | null> {
  const accountRows = await tenant.db
    .select({ id: accounts.id, type: accounts.type })
    .from(accounts)
    .where(
      tenant.scope(accounts, eq(accounts.connectionId, connection.id), eq(accounts.source, 'plaid'), eq(accounts.isHidden, false), isNull(accounts.missingSince)),
    );
  if (accountRows.length === 0) return null;
  const known = await tenant.db
    .select({ accountId: accountDaily.accountId, last: max(accountDaily.date) })
    .from(accountDaily)
    .where(
      tenant.scope(
        accountDaily,
        inArray(
          accountDaily.accountId,
          accountRows.map((row) => row.id),
        ),
        or(eq(accountDaily.source, 'backfill'), and(eq(accountDaily.source, 'sync'), eq(accountDaily.estimated, false))),
      ),
    )
    .groupBy(accountDaily.accountId);
  const lastKnown = new Map(known.map((row) => [row.accountId, row.last]));
  // Balances carried forward on days a sync was missed, still there because
  // no fill has replaced them yet (or one failed): those days are missed too,
  // even with known figures after them.
  const carried = await tenant.db
    .select({ accountId: accountDaily.accountId, first: min(accountDaily.date) })
    .from(accountDaily)
    .where(
      carriedForward(
        tenant,
        accountRows.map((row) => row.id),
        addDays(today, -HISTORY_DAYS),
        today,
      ),
    )
    .groupBy(accountDaily.accountId);
  const firstCarried = new Map(carried.map((row) => [row.accountId, row.first]));
  // Today's balance has just been synced (the snapshot follows), so a gap is
  // a day before yesterday with no known figure after it, or a carried day.
  const firstMissed = (accountId: string): IsoDate | null => {
    const last = lastKnown.get(accountId);
    const gap = last && last < addDays(today, -1) ? addDays(last, 1) : null;
    const days = [gap, firstCarried.get(accountId) ?? null].filter((day): day is IsoDate => day !== null).sort();
    return days[0] ?? null;
  };

  // The same split as the first load: with Assets, the bank covers all but investment accounts.
  const rebuilt = (type: string) => connection.hasInvestments && (!connection.hasBalanceHistory || type === 'investment');
  const bankDays = connection.hasBalanceHistory
    ? accountRows.filter((row) => !rebuilt(row.type)).flatMap((row) => firstMissed(row.id) ?? [])
    : [];
  const investments = accountRows.filter((row) => rebuilt(row.type)).flatMap((row) => {
    const from = firstMissed(row.id);
    return from ? [{ accountId: row.id, from }] : [];
  });
  const bankFrom = bankDays.sort()[0] ?? null;
  const from = [bankFrom, ...investments.map((row) => row.from)].filter((day): day is IsoDate => day !== null).sort()[0];
  return from ? { from, bankFrom, investments } : null;
}

/* ------------------------------------------------------------------ */
/* Bank & credit accounts (Plaid Assets)                               */
/* ------------------------------------------------------------------ */

/** Ask Plaid for an asset report; returns the statements recording the request. */
async function requestBalanceHistory(
  deps: Deps,
  tenant: Tenant,
  connection: ConnectionRow,
  webhookUrl: string | null,
  run: SyncRun,
  days: number,
): Promise<{ requested: boolean; statements: BatchItem<'sqlite'>[] }> {
  if (!deps.plaid) return { requested: false, statements: [] };
  const keys = await loadTokenKeys(deps.config.tokenEncKey);
  const accessToken = await accessTokenFor(deps, connection);
  try {
    const report = await run.plaid().createAssetReport(accessToken, days, webhookUrl);
    run.count('assetReportsRequested', 1);
    return {
      requested: true,
      statements: [
        tenant.db
        .update(connections)
        .set({
          assetReportTokenEnc: await encryptToken(keys, report.token, tokenAad(tenant.householdId, connection.id)),
          assetReportId: report.id,
        })
        .where(tenant.scope(connections, eq(connections.id, connection.id))),
      ],
    };
  } catch (error) {
    // No balance history after all: history comes from CSV import instead.
    if (error instanceof PlaidApiError) {
      run.note = `The institution didn't provide balance history (${error.code}); import a CSV instead.`;
      return { requested: false, statements: [] };
    }
    throw error;
  }
}
