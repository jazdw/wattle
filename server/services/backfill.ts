/**
 * History backfill when a connection is first linked:
 *  - investment accounts: rebuilt from investment transactions + daily closes
 *    (see backfillCore.ts);
 *  - bank and credit accounts: Plaid Asset Report `historical_balances`
 *    (up to 731 days), requested here and collected later (./assetReports).
 * Backfilled rows never overwrite synced, imported or manual rows, so a load
 * that fails part-way is safe to re-run: the rows are written in chunks, and
 * the outcome (status + log row) atomically at the end.
 */
import { eq, gte, inArray, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { addDays, marketDate } from '../../shared/dates';
import { PlaidApiError } from '../adapters/plaid';
import { chunkRows, runAtomic, runBatch } from '../db/batch';
import { accountDaily, accounts, connections, holdingDaily, holdings, investmentTransactions, securities } from '../db/schema';
import type { Tenant } from '../db/tenant';
import type { Deps } from '../ports';
import { reconstructHistory } from './backfillCore';
import { SyncRun, type SyncTrigger } from './activity';
import { encryptToken, loadTokenKeys, tokenAad } from './crypto';
import { closeLookup, ensureCloses, ensureFx } from './pricing';
import { connectionLease, Lease, LeaseLostError } from './lease';
import { accessTokenFor, getConnection, HISTORY_DAYS, underConnectionLease, type ConnectionRow } from './sync';
import { isCashSecurity, priceOn } from './valuation';

function backfillStatusStatement(tenant: Tenant, connectionId: string, status: ConnectionRow['backfillStatus']) {
  return tenant.db
    .update(connections)
    .set({ backfillStatus: status })
    .where(tenant.scope(connections, eq(connections.id, connectionId)));
}

/**
 * Load (or reload) a connection's history now, under its lease. If the
 * connection is busy, mark the load as due and leave a note: the holder runs
 * it before releasing. `webhookUrl` is where Plaid should report a finished
 * asset report (from the request origin, so no hostname is configured).
 */
export async function backfillConnection(
  deps: Deps,
  tenant: Tenant,
  connectionId: string,
  webhookUrl: string | null,
  trigger: SyncTrigger,
): Promise<void> {
  const connection = await getConnection(tenant, connectionId);
  if (!connection || connection.status === 'removed') return;
  const key = connectionLease(connection.id);
  let lease = await Lease.acquire(deps, tenant, key);
  if (!lease) {
    // Due: a load that never ran is "pending"; a reload is marked stale.
    await (connection.kind === 'investments' && connection.backfillStatus === 'done'
      ? tenant.db.update(connections).set({ historyStaleAt: deps.now().getTime() }).where(tenant.scope(connections, eq(connections.id, connection.id)))
      : backfillStatusStatement(tenant, connection.id, 'pending'));
    await Lease.leaveNote(deps, tenant, key);
    // The holder may have released just before the note: then run it ourselves.
    lease = await Lease.acquire(deps, tenant, key);
    if (!lease) {
      await new SyncRun(deps, tenant, connection.id, 'history', trigger).skipped('The connection was busy; the history load runs when that finishes.');
      return;
    }
  }
  await underConnectionLease(deps, tenant, connection.id, trigger, lease, { reportJustRequested: connection.kind === 'banking' }, () =>
    runHistoryLoad(deps, tenant, connection.id, trigger, lease, webhookUrl),
  );
}

/**
 * The history load itself; the caller holds the connection's lease (renewed
 * before every write). Investment history is rebuilt from transactions and
 * daily closes; for banks an asset report is requested (collected later).
 * Rows are written in chunks (insert-or-ignore, so a load that dies part-way
 * is safe to re-run), and the outcome with its log row atomically at the end.
 * Failures are logged, not thrown, except losing the lease.
 */
export async function runHistoryLoad(
  deps: Deps,
  tenant: Tenant,
  connectionId: string,
  trigger: SyncTrigger,
  lease: Lease,
  webhookUrl: string | null,
): Promise<void> {
  const connection = await getConnection(tenant, connectionId);
  if (!connection) return;
  const startedAt = deps.now().getTime();
  const today = marketDate(deps.now());
  const run = new SyncRun(deps, tenant, connection.id, 'history', trigger);
  try {
    await lease.renew();
    await backfillStatusStatement(tenant, connection.id, 'running');
    await ensureFx(deps, addDays(today, -HISTORY_DAYS), today);
    let outcome: BatchItem<'sqlite'>[];
    if (connection.kind === 'investments') {
      const accountRows = await tenant.db
        .select({ id: accounts.id })
        .from(accounts)
        .where(tenant.scope(accounts, eq(accounts.connectionId, connection.id), eq(accounts.isHidden, false)));
      const accountIds = accountRows.map((row) => row.id);
      if (connection.historyStaleAt !== null && connection.backfillStatus === 'done' && accountIds.length > 0) {
        // Rebuild: drop the previous estimate (only backfilled rows; synced,
        // imported and manual ones stay) and reconstruct with every transaction.
        run.note = 'Rebuilt because a transaction dated before the previous history arrived later.';
        await lease.renew();
        await runAtomic(tenant.db, [
          tenant.db.delete(accountDaily).where(tenant.scope(accountDaily, inArray(accountDaily.accountId, accountIds), eq(accountDaily.source, 'backfill'))),
          tenant.db.delete(holdingDaily).where(tenant.scope(holdingDaily, inArray(holdingDaily.accountId, accountIds), eq(holdingDaily.source, 'backfill'))),
        ]);
      }
      for (const accountId of accountIds) run.count('days', await backfillInvestmentAccount(deps, tenant, accountId, lease));
      outcome = [
        tenant.db
          .update(connections)
          .set({
            backfillStatus: 'done',
            historyAsOf: today,
            // A late transaction that arrived during this load needs another.
            historyStaleAt: sql`case when ${connections.historyStaleAt} < ${startedAt} then null else ${connections.historyStaleAt} end`,
          })
          .where(tenant.scope(connections, eq(connections.id, connection.id))),
      ];
    } else {
      outcome = await requestBalanceHistory(deps, tenant, connection, webhookUrl, run);
    }
    await lease.renew();
    await runAtomic(tenant.db, [...outcome, run.statement()]);
  } catch (error) {
    console.error('History load failed', error instanceof Error ? error.message : error);
    await run.failed(error);
    if (error instanceof LeaseLostError) throw error;
    await backfillStatusStatement(tenant, connection.id, 'failed');
  }
}

/* ------------------------------------------------------------------ */
/* Investment accounts                                                 */
/* ------------------------------------------------------------------ */

export async function backfillInvestmentAccount(deps: Deps, tenant: Tenant, accountId: string, lease?: Lease): Promise<number> {
  const [account] = await tenant.db
    .select()
    .from(accounts)
    .where(tenant.scope(accounts, eq(accounts.id, accountId)));
  if (!account || account.isHidden) return 0;

  const end = marketDate(deps.now());
  const start = addDays(end, -HISTORY_DAYS);

  const current = await tenant.db
    .select({ securityId: holdings.securityId, quantity: holdings.quantity })
    .from(holdings)
    .where(tenant.scope(holdings, eq(holdings.accountId, accountId)));
  const transactions = await tenant.db
    .select({
      date: investmentTransactions.date,
      securityId: investmentTransactions.securityId,
      quantity: investmentTransactions.quantity,
      amount: investmentTransactions.amount,
    })
    .from(investmentTransactions)
    .where(tenant.scope(investmentTransactions, eq(investmentTransactions.accountId, accountId), gte(investmentTransactions.date, start)));

  const securityRows = await tenant.db
    .select({
      id: securities.id,
      ticker: securities.ticker,
      type: securities.type,
      isPublic: securities.isPublic,
      lastPrice: securities.lastPrice,
      lastPriceDate: securities.lastPriceDate,
    })
    .from(securities)
    .where(tenant.scope(securities));
  const securityById = new Map(securityRows.map((security) => [security.id, security]));

  const involved = new Set([...current.map((row) => row.securityId), ...transactions.flatMap((row) => (row.securityId ? [row.securityId] : []))]);
  const tickers = [...involved].flatMap((id) => {
    const security = securityById.get(id);
    return security?.isPublic && security.ticker ? [security.ticker] : [];
  });
  await ensureCloses(deps, tickers, start, end);
  const closes = await closeLookup(deps, tickers, start, end);

  const cashSecurity = [...involved].find((id) => {
    const security = securityById.get(id);
    return security ? isCashSecurity(security) : false;
  });

  const days = reconstructHistory({
    start,
    end,
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
      accountId,
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
    accountId,
    date: day.date,
    balance: day.total,
    currency: account.currency,
    source: 'backfill' as const,
    estimated: day.estimated,
  }));

  // Today's row comes from the regular snapshot.
  await lease?.renew();
  await runBatch(tenant.db, [
    ...chunkRows(holdingDaily, holdingRows).map((chunk) => tenant.db.insert(holdingDaily).values(chunk).onConflictDoNothing()),
    ...chunkRows(accountDaily, accountRows).map((chunk) => tenant.db.insert(accountDaily).values(chunk).onConflictDoNothing()),
  ]);
  return accountRows.length;
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
): Promise<BatchItem<'sqlite'>[]> {
  if (!deps.plaid) return [];
  const keys = await loadTokenKeys(deps.config.tokenEncKey);
  const accessToken = await accessTokenFor(deps, connection);
  try {
    const report = await run.plaid().createAssetReport(accessToken, 731, webhookUrl);
    run.count('assetReportsRequested', 1);
    return [
      tenant.db
        .update(connections)
        .set({
          assetReportTokenEnc: await encryptToken(keys, report.token, tokenAad(tenant.householdId, connection.id)),
          assetReportId: report.id,
        })
        .where(tenant.scope(connections, eq(connections.id, connection.id))),
    ];
  } catch (error) {
    // Institutions without Assets support: history comes from CSV import instead.
    if (error instanceof PlaidApiError) {
      run.note = `The institution doesn't provide balance history (${error.code}); import a CSV instead.`;
      return [backfillStatusStatement(tenant, connection.id, 'skipped')];
    }
    throw error;
  }
}
