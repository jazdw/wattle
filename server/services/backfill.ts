/**
 * History backfill when a connection is first linked:
 *  - investment accounts: rebuilt from investment transactions + daily closes
 *    (see backfillCore.ts);
 *  - bank and credit accounts: Plaid Asset Report `historical_balances`
 *    (up to 731 days), requested once and collected via webhook or the daily job.
 * Backfilled rows never overwrite synced, imported or manual rows.
 */
import { eq, gte, isNotNull } from 'drizzle-orm';
import { addDays, marketDate } from '../../shared/dates';
import { toMinor } from '../../shared/money';
import { PlaidApiError } from '../adapters/plaid';
import { chunkRows, runBatch } from '../db/batch';
import { accountDaily, accounts, connections, holdingDaily, holdings, investmentTransactions, securities } from '../db/schema';
import type { Tenant } from '../db/tenant';
import type { Deps } from '../ports';
import { reconstructHistory } from './backfillCore';
import { decryptToken, encryptToken, loadTokenKeys, tokenAad } from './crypto';
import { closeLookup, ensureCloses, ensureFx } from './pricing';
import { accessTokenFor, getConnection, HISTORY_DAYS, type ConnectionRow } from './sync';
import { isCashSecurity, priceOn } from './valuation';

async function setBackfillStatus(tenant: Tenant, connectionId: string, status: ConnectionRow['backfillStatus']) {
  await tenant.db
    .update(connections)
    .set({ backfillStatus: status })
    .where(tenant.scope(connections, eq(connections.id, connectionId)));
}

/**
 * Start (or run) the backfill appropriate for a connection. `webhookUrl` is
 * where Plaid should report a finished asset report (derived from the request
 * origin, so no hostname is configured anywhere).
 */
export async function backfillConnection(
  deps: Deps,
  tenant: Tenant,
  connectionId: string,
  webhookUrl: string | null,
): Promise<void> {
  const connection = await getConnection(tenant, connectionId);
  if (!connection) return;
  const today = marketDate(deps.now());
  await setBackfillStatus(tenant, connection.id, 'running');
  try {
    await ensureFx(deps, addDays(today, -HISTORY_DAYS), today);
    if (connection.kind === 'investments') {
      const accountRows = await tenant.db
        .select({ id: accounts.id })
        .from(accounts)
        .where(tenant.scope(accounts, eq(accounts.connectionId, connection.id), eq(accounts.isHidden, false)));
      for (const account of accountRows) await backfillInvestmentAccount(deps, tenant, account.id);
      await setBackfillStatus(tenant, connection.id, 'done');
    } else {
      await requestBalanceHistory(deps, tenant, connection, webhookUrl);
    }
  } catch (error) {
    console.error('Backfill failed', error instanceof Error ? error.message : error);
    await setBackfillStatus(tenant, connection.id, 'failed');
  }
}

/* ------------------------------------------------------------------ */
/* Investment accounts                                                 */
/* ------------------------------------------------------------------ */

export async function backfillInvestmentAccount(deps: Deps, tenant: Tenant, accountId: string): Promise<number> {
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
  await runBatch(tenant.db, [
    ...chunkRows(holdingDaily, holdingRows).map((chunk) => tenant.db.insert(holdingDaily).values(chunk).onConflictDoNothing()),
    ...chunkRows(accountDaily, accountRows).map((chunk) => tenant.db.insert(accountDaily).values(chunk).onConflictDoNothing()),
  ]);
  return accountRows.length;
}

/* ------------------------------------------------------------------ */
/* Bank & credit accounts (Plaid Assets)                               */
/* ------------------------------------------------------------------ */

async function requestBalanceHistory(
  deps: Deps,
  tenant: Tenant,
  connection: ConnectionRow,
  webhookUrl: string | null,
): Promise<void> {
  if (!deps.plaid) return;
  const keys = await loadTokenKeys(deps.config.tokenEncKey);
  const accessToken = await accessTokenFor(deps, connection);
  try {
    const report = await deps.plaid.createAssetReport(accessToken, 731, webhookUrl);
    await tenant.db
      .update(connections)
      .set({
        assetReportTokenEnc: await encryptToken(keys, report.token, tokenAad(tenant.householdId, connection.id)),
        assetReportId: report.id,
      })
      .where(tenant.scope(connections, eq(connections.id, connection.id)));
  } catch (error) {
    // Institutions without Assets support: history comes from CSV import instead.
    if (error instanceof PlaidApiError) {
      console.warn('Asset report unavailable', error.code);
      await setBackfillStatus(tenant, connection.id, 'skipped');
      return;
    }
    throw error;
  }
}

/**
 * Collect pending asset reports. Called on the ASSETS webhook and by the
 * daily job (in case a webhook was missed). Returns true when the report was
 * ready and has been processed.
 */
export async function collectBalanceHistory(deps: Deps, tenant: Tenant, connectionId: string): Promise<boolean> {
  const connection = await getConnection(tenant, connectionId);
  if (!connection?.assetReportTokenEnc || !deps.plaid) return false;
  const keys = await loadTokenKeys(deps.config.tokenEncKey);
  const reportToken = await decryptToken(keys, connection.assetReportTokenEnc, tokenAad(tenant.householdId, connection.id));

  let report;
  try {
    report = await deps.plaid.getAssetReport(reportToken);
  } catch (error) {
    if (error instanceof PlaidApiError && error.code === 'PRODUCT_NOT_READY') return false;
    await tenant.db
      .update(connections)
      .set({ assetReportTokenEnc: null, assetReportId: null, backfillStatus: 'failed' })
      .where(tenant.scope(connections, eq(connections.id, connection.id)));
    throw error;
  }

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
  await runBatch(tenant.db, chunkRows(accountDaily, rows).map((chunk) => tenant.db.insert(accountDaily).values(chunk).onConflictDoNothing()));

  try {
    await deps.plaid.removeAssetReport(reportToken);
  } catch {
    // The report expires on its own.
  }
  await tenant.db
    .update(connections)
    .set({ assetReportTokenEnc: null, assetReportId: null, backfillStatus: 'done' })
    .where(tenant.scope(connections, eq(connections.id, connection.id)));
  return true;
}

/** Connections in a household with an asset report still outstanding. */
export async function pendingReports(tenant: Tenant): Promise<string[]> {
  const rows = await tenant.db
    .select({ id: connections.id })
    .from(connections)
    .where(tenant.scope(connections, isNotNull(connections.assetReportTokenEnc)));
  return rows.map((row) => row.id);
}
