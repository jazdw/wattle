/**
 * History backfill when a connection is first linked. A login can have both:
 *  - with Investments: investment accounts rebuilt from investment
 *    transactions + daily closes (see backfillCore.ts);
 *  - with Assets: the other accounts' Plaid Asset Report `historical_balances`
 *    (up to 731 days), requested here and collected later (./assetReports).
 * Backfilled rows never overwrite synced, imported or manual rows, so a load
 * that fails part-way is safe to re-run: the rows are written in chunks, and
 * the outcome (status + log row) atomically at the end.
 *
 * Later, days the syncs missed (balances carried forward as estimates) are
 * filled the same ways, for just those days (fillMissedDays).
 */
import { and, eq, gte, inArray, isNull, lt, max, or, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { addDays, dateRange, marketDate, type IsoDate } from '../../shared/dates';
import { PlaidApiError } from '../adapters/plaid';
import { chunkRows, runAtomic, runBatch } from '../db/batch';
import { accountDaily, accounts, connections, holdingDaily, holdings, investmentTransactions, securities } from '../db/schema';
import type { Tenant } from '../db/tenant';
import type { Deps } from '../ports';
import { reconstructHistory } from './backfillCore';
import { historyKeepsStopping, SyncRun, type SyncTrigger } from './activity';
import { encryptToken, loadTokenKeys, tokenAad } from './crypto';
import { closeLookup, ensureCloses, ensureFx } from './pricing';
import { connectionLease, Lease, LeaseLostError } from './lease';
import { accessTokenFor, getConnection, HISTORY_DAYS, HISTORY_STOPPED_NOTE, isActive, underConnectionLease, type ConnectionRow } from './sync';
import { isCashSecurity, priceOn } from './valuation';
import { describeError } from '../lib/errors';

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
  if (!connection || !isActive(connection)) return;
  const key = connectionLease(connection.id);
  let lease = await Lease.acquire(deps, tenant, key);
  if (!lease) {
    // Due: a load that never ran is "pending"; a reload is marked stale.
    await (connection.hasInvestments && connection.backfillStatus === 'done'
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
  await underConnectionLease(deps, tenant, connection.id, trigger, lease, { reportJustRequested: connection.hasBalanceHistory }, () =>
    runHistoryLoad(deps, tenant, connection.id, trigger, lease, webhookUrl),
  );
}

/**
 * The history load itself; the caller holds the connection's lease (renewed
 * before every write). Investment history is rebuilt from transactions and
 * daily closes; with Assets an asset report is requested (collected later)
 * for the other accounts. A rebuild after a late transaction redoes only the
 * investment history.
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
    await run.begin();
    await backfillStatusStatement(tenant, connection.id, 'running');
    await ensureFx(deps, addDays(today, -HISTORY_DAYS), today);
    const rebuild = connection.historyStaleAt !== null && connection.backfillStatus === 'done';
    const outcome: BatchItem<'sqlite'>[] = [];
    // Two years, asked for on the first load: a rebuild only redoes investments.
    const report = connection.hasBalanceHistory && !rebuild ? await requestBalanceHistory(deps, tenant, connection, webhookUrl, run, 731) : null;
    if (report) outcome.push(...report.statements);
    if (connection.hasInvestments) {
      const accountRows = await tenant.db
        .select({ id: accounts.id, type: accounts.type })
        .from(accounts)
        .where(tenant.scope(accounts, eq(accounts.connectionId, connection.id), eq(accounts.isHidden, false)));
      // With Assets, the bank's balance history covers the other accounts.
      const accountIds = accountRows.filter((row) => !connection.hasBalanceHistory || row.type === 'investment').map((row) => row.id);
      if (rebuild && accountIds.length > 0) {
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
      outcome.push(
        tenant.db
          .update(connections)
          .set({
            // Still waiting for the bank's report, if one was asked for.
            backfillStatus: report?.requested ? 'running' : 'done',
            historyAsOf: today,
            // A late transaction that arrived during this load needs another.
            historyStaleAt: sql`case when ${connections.historyStaleAt} < ${startedAt} then null else ${connections.historyStaleAt} end`,
          })
          .where(tenant.scope(connections, eq(connections.id, connection.id))),
      );
    } else if (!report?.requested) {
      outcome.push(backfillStatusStatement(tenant, connection.id, 'skipped'));
    }
    await lease.renew();
    await runAtomic(tenant.db, [...outcome, run.statement()]);
  } catch (error) {
    console.error('History load failed', describeError(error));
    await run.failed(error);
    if (error instanceof LeaseLostError) throw error;
    await backfillStatusStatement(tenant, connection.id, 'failed');
  }
}

/* ------------------------------------------------------------------ */
/* Investment accounts                                                 */
/* ------------------------------------------------------------------ */

/**
 * Rebuild an investment account's daily history from today's holdings back
 * through its transactions. With `from`, only from that day, replacing the
 * balances carried forward (estimated) while syncs were missed.
 */
export async function backfillInvestmentAccount(deps: Deps, tenant: Tenant, accountId: string, lease?: Lease, from?: IsoDate): Promise<number> {
  const [account] = await tenant.db
    .select()
    .from(accounts)
    .where(tenant.scope(accounts, eq(accounts.id, accountId)));
  if (!account || account.isHidden) return 0;

  const end = marketDate(deps.now());
  const start = from ?? addDays(end, -HISTORY_DAYS);

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

  const inserts = [
    ...chunkRows(holdingDaily, holdingRows).map((chunk) => tenant.db.insert(holdingDaily).values(chunk).onConflictDoNothing()),
    ...chunkRows(accountDaily, accountRows).map((chunk) => tenant.db.insert(accountDaily).values(chunk).onConflictDoNothing()),
  ];
  // Today's row comes from the regular snapshot.
  await lease?.renew();
  if (!from) {
    await runBatch(tenant.db, inserts);
    return accountRows.length;
  }
  // Missed days: the carried-forward snapshot rows give way, with their
  // positions, in the same batch (entered and imported ones stay).
  const carried = (
    await tenant.db
      .select({ date: accountDaily.date })
      .from(accountDaily)
      .where(carriedForward(tenant, [accountId], from, end))
  ).map((row) => row.date);
  await runAtomic(tenant.db, [
    ...(carried.length > 0
      ? [
          tenant.db
            .delete(holdingDaily)
            .where(tenant.scope(holdingDaily, eq(holdingDaily.accountId, accountId), eq(holdingDaily.source, 'sync'), inArray(holdingDaily.date, carried))),
          tenant.db.delete(accountDaily).where(carriedForward(tenant, [accountId], from, end)),
        ]
      : []),
    ...inserts,
  ]);
  return accountRows.filter((row) => carried.includes(row.date)).length;
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
  // Today's balance has just been synced (the snapshot follows), so a gap is
  // a day before yesterday with no known figure after it.
  const firstMissed = (accountId: string): IsoDate | null => {
    const last = lastKnown.get(accountId);
    return last && last < addDays(today, -1) ? addDays(last, 1) : null;
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

/**
 * Fill the days syncs missed (a failed night, or disconnected meanwhile):
 * ask the bank for those days' balances (collected later, replacing only
 * carried-forward ones), and rebuild investment accounts from their
 * transactions for those days. Once per gap: days the bank has nothing for
 * stay estimated but are marked as asked (./assetReports). The caller holds
 * the connection's lease.
 */
export async function fillMissedDays(deps: Deps, tenant: Tenant, connectionId: string, trigger: SyncTrigger, lease: Lease): Promise<void> {
  const connection = await getConnection(tenant, connectionId);
  // Not before the first history load is in, nor while a report is outstanding.
  if (!connection || connection.status !== 'ok' || connection.backfillStatus !== 'done' || connection.assetReportTokenEnc) return;
  const today = marketDate(deps.now());
  const missed = await missedDays(tenant, connection, today);
  if (!missed) return;
  if (trigger !== 'manual' && (await historyKeepsStopping(tenant, connection.id))) {
    await new SyncRun(deps, tenant, connection.id, 'history', trigger).skipped(HISTORY_STOPPED_NOTE);
    return;
  }

  const run = new SyncRun(deps, tenant, connection.id, 'history', trigger);
  run.note = `Filling days missed since ${missed.from}.`;
  try {
    await run.begin();
    const outcome: BatchItem<'sqlite'>[] = [];
    if (missed.bankFrom) {
      const report = await requestBalanceHistory(deps, tenant, connection, null, run, Math.min(731, dateRange(missed.bankFrom, today).length));
      outcome.push(...report.statements);
    }
    for (const { accountId, from } of missed.investments) {
      run.count('days', await backfillInvestmentAccount(deps, tenant, accountId, lease, from));
    }
    await lease.renew();
    await runAtomic(tenant.db, [...outcome, run.statement()]);
  } catch (error) {
    await run.failed(error);
    if (error instanceof LeaseLostError) throw error;
    console.error('Filling missed days failed', describeError(error));
  }
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
