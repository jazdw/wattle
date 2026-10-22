/**
 * Bank and card balance history from a Plaid Asset Report, once Plaid has
 * built it (requested by the history load in ./backfill). Collected under the
 * connection's lease whenever a report is outstanding: after the ASSETS
 * webhook, on Sync, and nightly (in case the webhook was missed).
 */
import { eq, inArray, lt, ne, sql } from 'drizzle-orm';
import { marketDate } from '../../shared/dates';
import { toMinor } from '../../shared/money';
import { PlaidApiError } from '../adapters/plaid';
import { chunkRows, runAtomic } from '../db/batch';
import { accountDaily, accounts, connections } from '../db/schema';
import type { Tenant } from '../db/tenant';
import type { Deps } from '../ports';
import { SyncRun, type SyncTrigger } from './activity';
import { decryptToken, loadTokenKeys, tokenAad } from './crypto';
import type { Lease } from './lease';
import type { ConnectionRow } from './sync';

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

/**
 * Collect the connection's outstanding report, if any. The balances, the
 * connection's history status and the log row are written in one atomic
 * batch. Returns true when a report was collected.
 */
export async function collectPendingReport(
  deps: Deps,
  tenant: Tenant,
  connection: ConnectionRow,
  trigger: SyncTrigger,
  lease: Lease,
): Promise<boolean> {
  if (!connection.assetReportTokenEnc || !deps.plaid) return false;
  const run = new SyncRun(deps, tenant, connection.id, 'balance_history', trigger);
  const plaid = run.plaid();
  let reportToken: string;
  let report;
  try {
    await run.begin();
    const keys = await loadTokenKeys(deps.config.tokenEncKey);
    reportToken = await decryptToken(keys, connection.assetReportTokenEnc, tokenAad(tenant.householdId, connection.id));
    report = await plaid.getAssetReport(reportToken);
  } catch (error) {
    if (error instanceof PlaidApiError && error.code === 'PRODUCT_NOT_READY') {
      await run.skipped('Plaid is still preparing the report.');
      return false;
    }
    if (!(error instanceof PlaidApiError)) {
      await run.failed(error);
      throw error;
    }
    // Plaid couldn't build the report: give up on it (CSV import instead).
    // Investment history, if the login has it, was loaded already.
    run.fail(error);
    await lease.renew();
    await runAtomic(tenant.db, [
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
    ]);
    return false;
  }

  try {
    const accountRows = await tenant.db
      .select({ id: accounts.id, externalId: accounts.externalId, type: accounts.type, currency: accounts.currency })
      .from(accounts)
      .where(tenant.scope(accounts, eq(accounts.connectionId, connection.id), eq(accounts.isHidden, false)));
    const byExternal = new Map(accountRows.map((row) => [row.externalId, row]));

    const rows: (typeof accountDaily.$inferInsert)[] = [];
    for (const item of report.items) {
      for (const reportAccount of item.accounts) {
        const account = byExternal.get(reportAccount.account_id);
        if (!account) continue;
        // Investment accounts' history is rebuilt from their transactions.
        if (connection.hasInvestments && account.type === 'investment') continue;
        const liability = account.type === 'credit' || account.type === 'loan';
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
      }
    }
    run.count('days', rows.length);
    await lease.renew();
    await runAtomic(tenant.db, [
      ...chunkRows(accountDaily, rows).map((chunk) =>
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
      ),
      askedStatement(deps, tenant, connection),
      tenant.db
        .update(connections)
        .set({ assetReportTokenEnc: null, assetReportId: null, backfillStatus: 'done' })
        .where(tenant.scope(connections, eq(connections.id, connection.id))),
      run.statement(),
    ]);
  } catch (error) {
    await run.failed(error);
    throw error;
  }

  // Delete the report at Plaid only now that its balances are stored
  // (deleting first, then failing to store, would lose them). The call is
  // added to the log entry written above. A failure is fine: reports expire.
  try {
    await plaid.removeAssetReport(reportToken);
  } catch {
    // recorded in the call log with Plaid's error code
  }
  await run.recordLateCalls();
  return true;
}
