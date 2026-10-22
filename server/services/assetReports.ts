/**
 * Bank and card balance history from a Plaid Asset Report, once Plaid has
 * built it (requested by a history plan in ./backfill). Collected by
 * background jobs (./jobRunner), queued whenever a report is outstanding:
 * after the ASSETS webhook's sync, on Sync, and nightly (in case the webhook
 * was missed).
 *   report_collect  fetch the report; a small one is written right away,
 *                   a large one becomes one report_account job per account
 *   report_account  write one account's balances (the report fetched again)
 *   report_finish   mark the report collected, then delete it at Plaid
 * Balances only replace ones carried forward while syncs were missed, so any
 * of them can run again safely.
 */
import { eq, gt, inArray, lt, ne, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { AssetReport } from 'plaid';
import { marketDate } from '../../shared/dates';
import { toMinor } from '../../shared/money';
import { PlaidApiError } from '../adapters/plaid';
import { chunkRows, runAtomic } from '../db/batch';
import { accountDaily, accounts, connections, jobs } from '../db/schema';
import type { Tenant } from '../db/tenant';
import type { Deps } from '../ports';
import { completeRunStatements, SyncRun, type SyncTrigger } from './activity';
import { decryptToken, loadTokenKeys, tokenAad } from './crypto';
import { enqueue, RetryLater, type JobContext } from './jobRunner';
import { connectionLease, Lease } from './lease';
import { getConnection, isActive, type ConnectionRow } from './sync';

/**
 * Days the bank was asked about but had no figure for keep their carried-forward
 * balance, still estimated, relabelled as bank history: missed-days detection
 * (./backfill) then counts them as covered and doesn't ask again.
 */
function askedStatement(deps: Deps, tenant: Tenant, connection: ConnectionRow) {
  const covered = tenant.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      tenant.scope(
        accounts,
        eq(accounts.connectionId, connection.id),
        // Investment accounts' history is rebuilt from their transactions instead.
        ...(connection.hasInvestments ? [ne(accounts.type, 'investment')] : []),
      ),
    );
  return tenant.db
    .update(accountDaily)
    .set({ source: 'backfill' })
    .where(
      tenant.scope(
        accountDaily,
        inArray(accountDaily.accountId, covered),
        eq(accountDaily.source, 'sync'),
        eq(accountDaily.estimated, true),
        lt(accountDaily.date, marketDate(deps.now())),
      ),
    );
}

interface CollectPayload {
  connectionId: string;
  trigger: SyncTrigger;
  runId: string;
}

interface AccountPayload extends CollectPayload {
  accountId: string;
}

/** Plaid usually builds a report in minutes: check again after this... */
const NOT_READY_RETRY_SECONDS = 10 * 60;
/** ...for at most a day; then the next sync queues a fresh check. */
const NOT_READY_GIVE_UP_MS = 24 * 3600 * 1000;
const BUSY_RETRY_SECONDS = 30;
const accountsGroup = (runId: string) => `report:${runId}:accounts`;

/**
 * Queue collecting the connection's outstanding report, unless that's
 * underway. A collection waiting to check again (the report wasn't ready) is
 * made due now: Sync, or Plaid's webhook, means it's worth looking. With
 * `delaySeconds` (just asked for), the first check is that much later.
 */
export async function queueReportCollection(deps: Deps, tenant: Tenant, connection: ConnectionRow, trigger: SyncTrigger, delaySeconds = 0): Promise<void> {
  if (!connection.assetReportTokenEnc) return;
  const now = deps.now().getTime();
  if (delaySeconds === 0) {
    const sooner = await tenant.db
      .update(jobs)
      .set({ runAfter: now })
      .where(tenant.scope(jobs, eq(jobs.connectionId, connection.id), eq(jobs.type, 'report_collect'), eq(jobs.status, 'queued'), gt(jobs.runAfter, now)))
      .returning({ id: jobs.id });
    if (sooner.length > 0) await deps.jobQueue.wake(sooner.map((row) => row.id));
  }
  const [underway] = await tenant.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      tenant.scope(
        jobs,
        eq(jobs.connectionId, connection.id),
        inArray(jobs.type, ['report_collect', 'report_account', 'report_finish']),
        inArray(jobs.status, ['waiting', 'queued', 'running']),
      ),
    )
    .limit(1);
  if (underway) return;
  const runId = crypto.randomUUID();
  const payload: CollectPayload = { connectionId: connection.id, trigger, runId };
  await enqueue(deps, tenant, [
    { id: `report:${runId}:collect`, type: 'report_collect', payload: { ...payload }, connectionId: connection.id, runAfter: now + delaySeconds * 1000 },
  ]);
}

async function fetchReport(deps: Deps, tenant: Tenant, connection: ConnectionRow, run: SyncRun): Promise<{ report: AssetReport; token: string }> {
  const keys = await loadTokenKeys(deps.config.tokenEncKey);
  const token = await decryptToken(keys, connection.assetReportTokenEnc!, tokenAad(tenant.householdId, connection.id));
  return { report: await run.plaid().getAssetReport(token), token };
}

/** The report's daily balances for the connection's accounts, by account id. */
async function balancesByAccount(tenant: Tenant, connection: ConnectionRow, report: AssetReport) {
  const accountRows = await tenant.db
    .select({ id: accounts.id, externalId: accounts.externalId, type: accounts.type, currency: accounts.currency })
    .from(accounts)
    .where(tenant.scope(accounts, eq(accounts.connectionId, connection.id), eq(accounts.isHidden, false)));
  const byExternal = new Map(accountRows.map((row) => [row.externalId, row]));
  const result = new Map<string, (typeof accountDaily.$inferInsert)[]>();
  for (const item of report.items) {
    for (const reportAccount of item.accounts) {
      const account = byExternal.get(reportAccount.account_id);
      if (!account) continue;
      // Investment accounts' history is rebuilt from their transactions.
      if (connection.hasInvestments && account.type === 'investment') continue;
      const liability = account.type === 'credit' || account.type === 'loan';
      const rows = result.get(account.id) ?? [];
      for (const balance of reportAccount.historical_balances ?? []) {
        const minor = toMinor(balance.current);
        rows.push({
          householdId: tenant.householdId,
          accountId: account.id,
          date: balance.date,
          balance: liability ? -Math.abs(minor) : minor,
          currency: balance.iso_currency_code ?? account.currency,
          source: 'backfill',
        });
      }
      result.set(account.id, rows);
    }
  }
  return result;
}

function balanceStatements(tenant: Tenant, rows: (typeof accountDaily.$inferInsert)[]): BatchItem<'sqlite'>[] {
  return chunkRows(accountDaily, rows).map((chunk) =>
    tenant.db
      .insert(accountDaily)
      .values(chunk)
      .onConflictDoUpdate({
        target: [accountDaily.accountId, accountDaily.date],
        set: { balance: sql`excluded.balance`, source: sql`excluded.source`, estimated: sql`0` },
        // Only balances carried forward because a sync was missed; reported,
        // entered and imported ones stay.
        setWhere: sql`${accountDaily.source} = 'sync' and ${accountDaily.estimated} = 1`,
      }),
  );
}

/** The report is in: days it had nothing for are marked asked, and the connection's history is done. */
function collectedStatements(deps: Deps, tenant: Tenant, connection: ConnectionRow): BatchItem<'sqlite'>[] {
  return [
    askedStatement(deps, tenant, connection),
    tenant.db
      .update(connections)
      .set({ assetReportTokenEnc: null, assetReportId: null, backfillStatus: 'done' })
      .where(tenant.scope(connections, eq(connections.id, connection.id))),
  ];
}

/** Hold the connection's lease for a write (a sync may be finishing). */
async function withLease<T>(deps: Deps, tenant: Tenant, connectionId: string, renew: () => Promise<void>, write: () => Promise<T>): Promise<T> {
  const lease = await Lease.acquireWaiting(deps, tenant, connectionLease(connectionId));
  if (!lease) throw new RetryLater(BUSY_RETRY_SECONDS, 'The connection is busy.');
  try {
    await renew();
    await lease.renew();
    return await write();
  } finally {
    await lease.forceRelease();
  }
}

/**
 * Delete the report at Plaid, now that its balances are stored (deleting
 * first, then failing to store, would lose them). A failure is fine: reports
 * expire.
 */
async function removeReport(run: SyncRun, token: string): Promise<void> {
  try {
    await run.plaid().removeAssetReport(token);
  } catch {
    // recorded in the call log with Plaid's error code
  }
  await run.recordLateCalls();
}

/** report_collect: fetch the report, write it (or split it into a job per account). */
export async function collectReport({ deps, tenant, job, renew }: JobContext): Promise<Record<string, unknown>> {
  const collect = job.payload as unknown as CollectPayload;
  const connection = await getConnection(tenant, collect.connectionId);
  if (!connection?.assetReportTokenEnc || !isActive(connection) || !deps.plaid) return { skipped: 'no report outstanding' };
  const run = new SyncRun(deps, tenant, connection.id, 'balance_history', collect.trigger, collect.runId);
  let fetched: { report: AssetReport; token: string };
  try {
    fetched = await fetchReport(deps, tenant, connection, run);
  } catch (error) {
    if (error instanceof PlaidApiError && error.code === 'PRODUCT_NOT_READY') {
      if (deps.now().getTime() - job.createdAt < NOT_READY_GIVE_UP_MS) throw new RetryLater(NOT_READY_RETRY_SECONDS, 'Plaid is still preparing the report.');
      await run.skipped('Plaid was still preparing the report after a day; the next sync checks again.');
      return { skipped: 'not ready' };
    }
    if (!(error instanceof PlaidApiError)) throw error;
    // Plaid couldn't build the report: give up on it (CSV import instead).
    // Investment history, if the login has it, was loaded already.
    run.fail(error);
    await withLease(deps, tenant, connection.id, renew, () =>
      runAtomic(tenant.db, [
        askedStatement(deps, tenant, connection),
        tenant.db
          .update(connections)
          // A report filling missed days leaves the loaded history as it was.
          .set({
            assetReportTokenEnc: null,
            assetReportId: null,
            backfillStatus: connection.backfillStatus !== 'running' ? connection.backfillStatus : connection.hasInvestments ? 'done' : 'failed',
          })
          .where(tenant.scope(connections, eq(connections.id, connection.id))),
        run.statement(),
      ]),
    );
    return { failed: error.code };
  }

  const byAccount = await balancesByAccount(tenant, connection, fetched.report);
  const days = [...byAccount.values()].reduce((sum, rows) => sum + rows.length, 0);
  if (days <= deps.config.jobChunkRows) {
    run.count('days', days);
    await withLease(deps, tenant, connection.id, renew, () =>
      runAtomic(tenant.db, [...balanceStatements(tenant, [...byAccount.values()].flat()), ...collectedStatements(deps, tenant, connection), run.statement()]),
    );
    await removeReport(run, fetched.token);
    return { days };
  }
  // Large: one job per account, then the finish.
  await run.begin();
  await renew();
  await runAtomic(tenant.db, [run.statement('running')]);
  await enqueue(deps, tenant, [
    ...[...byAccount.keys()].map((accountId) => {
      const payload: AccountPayload = { ...collect, accountId };
      return { type: 'report_account' as const, payload: { ...payload }, connectionId: connection.id, groupId: accountsGroup(collect.runId) };
    }),
    { id: `report:${collect.runId}:finish`, type: 'report_finish', payload: { ...collect }, connectionId: connection.id, waitsFor: accountsGroup(collect.runId) },
  ]);
  return { accounts: byAccount.size };
}

/** report_account: one account's balances from the report. */
export async function collectReportAccount({ deps, tenant, job, renew }: JobContext): Promise<Record<string, unknown>> {
  const payload = job.payload as unknown as AccountPayload;
  const connection = await getConnection(tenant, payload.connectionId);
  if (!connection?.assetReportTokenEnc || !deps.plaid) return { days: 0 };
  const run = new SyncRun(deps, tenant, connection.id, 'balance_history', payload.trigger);
  const { report } = await fetchReport(deps, tenant, connection, run);
  const rows = (await balancesByAccount(tenant, connection, report)).get(payload.accountId) ?? [];
  await withLease(deps, tenant, connection.id, renew, () => runAtomic(tenant.db, balanceStatements(tenant, rows)));
  return { days: rows.length };
}

/** report_finish: every account is in; mark the report collected and delete it at Plaid. */
export async function finishReport({ deps, tenant, job, renew }: JobContext): Promise<Record<string, unknown>> {
  const finish = job.payload as unknown as CollectPayload;
  const parts = await tenant.db
    .select({ status: jobs.status, result: jobs.result })
    .from(jobs)
    .where(tenant.scope(jobs, eq(jobs.groupId, accountsGroup(finish.runId))));
  const failed = parts.filter((part) => part.status === 'failed').length;
  const days = parts.reduce((sum, part) => sum + (Number(part.result?.days) || 0), 0);
  const connection = await getConnection(tenant, finish.connectionId);
  if (!connection?.assetReportTokenEnc) return { days, failed };
  const run = new SyncRun(deps, tenant, connection.id, 'balance_history', finish.trigger, finish.runId);
  if (failed > 0) {
    // Leave the report outstanding: the next sync collects it again.
    await renew();
    await runAtomic(tenant.db, await completeRunStatements(deps, tenant, finish.runId, {
      counts: { days },
      error: { code: 'PARTS_FAILED', message: `${failed} of ${parts.length} accounts' balance history couldn't be stored; the next sync tries again.` },
    }));
    return { days, failed };
  }
  const keys = await loadTokenKeys(deps.config.tokenEncKey);
  const token = await decryptToken(keys, connection.assetReportTokenEnc, tokenAad(tenant.householdId, connection.id));
  const statements = [...collectedStatements(deps, tenant, connection), ...(await completeRunStatements(deps, tenant, finish.runId, { counts: { days } }))];
  await withLease(deps, tenant, connection.id, renew, () => runAtomic(tenant.db, statements));
  await removeReport(run, token);
  return { days };
}

/** A collection that failed for good: recorded on its run; the report stays outstanding for the next sync. */
export async function reportFailed({ deps, tenant, job }: JobContext, error: { code: string | null; message: string }): Promise<void> {
  const { connectionId, trigger, runId } = job.payload as unknown as CollectPayload;
  const run = new SyncRun(deps, tenant, connectionId, 'balance_history', trigger, runId);
  run.error = { code: error.code, message: error.message.slice(0, 500) };
  await runAtomic(tenant.db, [run.statement()]);
}
