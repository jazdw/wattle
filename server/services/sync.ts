/**
 * Aggregator connections: linking, syncing balances/holdings/investment
 * transactions, and error states. Data for hidden accounts is dropped here —
 * it is never written.
 */
import { eq, inArray, notInArray } from 'drizzle-orm';
import type { AccountBase, Security as PlaidSecurity } from 'plaid';
import { suggestClassification } from '../../shared/classify';
import { addDays, marketDate } from '../../shared/dates';
import { toMinor } from '../../shared/money';
import { PlaidApiError, type LinkKind } from '../adapters/plaid';
import { chunkRows, runBatch } from '../db/batch';
import { accounts, connections, holdings, investmentTransactions, securities } from '../db/schema';
import type { Tenant } from '../db/tenant';
import type { Deps } from '../ports';
import { decryptToken, encryptToken, loadTokenKeys, tokenAad } from './crypto';

export type ConnectionRow = typeof connections.$inferSelect;

/** Two years: the most investment history Plaid returns. */
export const HISTORY_DAYS = 730;

const LIABILITY_TYPES = new Set(['credit', 'loan']);

function requirePlaid(deps: Deps) {
  if (!deps.plaid) throw new Error('Plaid is not configured (PLAID_CLIENT_ID / PLAID_SECRET).');
  return deps.plaid;
}

/** Signed balance in minor units: liabilities are negative. */
export function plaidBalance(account: Pick<AccountBase, 'type' | 'balances'>): number | null {
  const amount = account.balances.current ?? account.balances.available;
  if (amount === null || amount === undefined) return null;
  const minor = toMinor(amount);
  return LIABILITY_TYPES.has(account.type) ? -Math.abs(minor) : minor;
}

export async function accessTokenFor(deps: Deps, connection: ConnectionRow): Promise<string> {
  const keys = await loadTokenKeys(deps.config.tokenEncKey);
  return decryptToken(keys, connection.accessTokenEnc, tokenAad(connection.householdId, connection.id));
}

export async function getConnection(tenant: Tenant, connectionId: string): Promise<ConnectionRow | null> {
  const [row] = await tenant.db
    .select()
    .from(connections)
    .where(tenant.scope(connections, eq(connections.id, connectionId)));
  return row ?? null;
}

/* ------------------------------------------------------------------ */
/* Linking                                                             */
/* ------------------------------------------------------------------ */

export async function linkConnection(
  deps: Deps,
  tenant: Tenant,
  ownerUserId: string,
  publicToken: string,
  kind: LinkKind,
): Promise<ConnectionRow> {
  const plaid = requirePlaid(deps);
  const keys = await loadTokenKeys(deps.config.tokenEncKey);
  const { accessToken, itemId } = await plaid.exchangePublicToken(publicToken);

  // Re-linking the same login updates the existing connection.
  const [existing] = await tenant.db
    .select()
    .from(connections)
    .where(tenant.scope(connections, eq(connections.provider, 'plaid'), eq(connections.externalId, itemId)));
  const id = existing?.id ?? crypto.randomUUID();
  const accessTokenEnc = await encryptToken(keys, accessToken, tokenAad(tenant.householdId, id));

  const item = await plaid.getItem(accessToken);
  const institutionName = item.institution_id ? await plaid.getInstitutionName(item.institution_id) : null;
  const consentExpiresAt = item.consent_expiration_time ? Date.parse(item.consent_expiration_time) : null;

  if (existing) {
    await tenant.db
      .update(connections)
      .set({ accessTokenEnc, status: 'ok', errorCode: null, consentExpiresAt })
      .where(tenant.scope(connections, eq(connections.id, id)));
  } else {
    await tenant.db.insert(connections).values({
      id,
      householdId: tenant.householdId,
      ownerUserId,
      provider: 'plaid',
      externalId: itemId,
      accessTokenEnc,
      institutionId: item.institution_id ?? null,
      institutionName,
      kind,
      consentExpiresAt,
      createdAt: deps.now().getTime(),
    });
  }
  return (await getConnection(tenant, id))!;
}

/* ------------------------------------------------------------------ */
/* Sync                                                                */
/* ------------------------------------------------------------------ */

export interface SyncResult {
  accounts: number;
  holdings: number;
  transactions: number;
  status: ConnectionRow['status'];
}

function statusForError(error: unknown): { status: ConnectionRow['status']; code: string } | null {
  if (!(error instanceof PlaidApiError)) return null;
  if (error.code === 'ITEM_LOGIN_REQUIRED' || error.code === 'PENDING_DISCONNECT') {
    return { status: 'login_required', code: error.code };
  }
  if (error.type === 'ITEM_ERROR' || error.type === 'INSTITUTION_ERROR') return { status: 'error', code: error.code };
  return null;
}

/** Pull the latest balances (and holdings/transactions for investment logins). */
export async function syncConnection(deps: Deps, tenant: Tenant, connectionId: string): Promise<SyncResult> {
  const plaid = requirePlaid(deps);
  const connection = await getConnection(tenant, connectionId);
  if (!connection) throw new Error('Connection not found.');
  if (connection.status === 'removed') return { accounts: 0, holdings: 0, transactions: 0, status: 'removed' };

  const accessToken = await accessTokenFor(deps, connection);
  const now = deps.now();
  try {
    const plaidAccounts = await plaid.getAccounts(accessToken);
    const accountIds = await upsertAccounts(deps, tenant, connection, plaidAccounts);

    let holdingCount = 0;
    let transactionCount = 0;
    if (connection.kind === 'investments') {
      holdingCount = await syncHoldings(deps, tenant, accessToken, accountIds);
      transactionCount = await syncInvestmentTransactions(deps, tenant, connection, accessToken, accountIds);
    }

    await tenant.db
      .update(connections)
      .set({ status: 'ok', errorCode: null, lastSyncedAt: now.getTime() })
      .where(tenant.scope(connections, eq(connections.id, connection.id)));
    return { accounts: plaidAccounts.length, holdings: holdingCount, transactions: transactionCount, status: 'ok' };
  } catch (error) {
    const mapped = statusForError(error);
    if (!mapped) throw error;
    await tenant.db
      .update(connections)
      .set({ status: mapped.status, errorCode: mapped.code })
      .where(tenant.scope(connections, eq(connections.id, connection.id)));
    return { accounts: 0, holdings: 0, transactions: 0, status: mapped.status };
  }
}

/**
 * Insert new accounts and refresh existing ones. Returns Plaid account_id →
 * Wattle account id for the accounts that are NOT hidden.
 */
async function upsertAccounts(
  deps: Deps,
  tenant: Tenant,
  connection: ConnectionRow,
  plaidAccounts: AccountBase[],
): Promise<Map<string, { id: string; currency: string }>> {
  const now = deps.now().getTime();
  const existing = await tenant.db
    .select({ id: accounts.id, externalId: accounts.externalId, isHidden: accounts.isHidden })
    .from(accounts)
    .where(tenant.scope(accounts, eq(accounts.connectionId, connection.id)));
  const byExternal = new Map(existing.map((row) => [row.externalId, row]));
  const visible = new Map<string, { id: string; currency: string }>();

  for (const account of plaidAccounts) {
    const currency = account.balances.iso_currency_code ?? 'USD';
    const current = byExternal.get(account.account_id);
    const descriptive = {
      name: account.name,
      officialName: account.official_name ?? null,
      // Plaid's mask is already the last 2–4 characters; never keep more.
      mask: account.mask ? account.mask.slice(-4) : null,
      type: account.type,
      subtype: account.subtype ?? null,
      institutionName: connection.institutionName,
    };

    if (!current) {
      const id = crypto.randomUUID();
      await tenant.db.insert(accounts).values({
        id,
        householdId: tenant.householdId,
        source: 'plaid',
        connectionId: connection.id,
        externalId: account.account_id,
        ...descriptive,
        currency,
        ownerUserId: connection.ownerUserId,
        category: account.type === 'depository' ? 'cash' : null,
        balance: plaidBalance(account),
        balanceAsOf: now,
        createdAt: now,
      });
      visible.set(account.account_id, { id, currency });
      continue;
    }

    if (current.isHidden) {
      // Keep only the descriptive fields so the account can be recognised and
      // un-hidden; its balance is not stored.
      await tenant.db.update(accounts).set(descriptive).where(tenant.scope(accounts, eq(accounts.id, current.id)));
      continue;
    }
    await tenant.db
      .update(accounts)
      .set({ ...descriptive, currency, balance: plaidBalance(account), balanceAsOf: now })
      .where(tenant.scope(accounts, eq(accounts.id, current.id)));
    visible.set(account.account_id, { id: current.id, currency });
  }
  return visible;
}

function isPublicSecurity(security: PlaidSecurity): boolean {
  const ticker = security.ticker_symbol ?? '';
  return (
    ticker.length > 0 &&
    !ticker.startsWith('CUR:') &&
    security.type !== 'cash' &&
    security.type !== 'derivative' &&
    security.close_price !== null &&
    security.close_price !== undefined
  );
}

/** Upsert Plaid securities; returns Plaid security_id → Wattle security id. */
export async function upsertSecurities(
  deps: Deps,
  tenant: Tenant,
  plaidSecurities: PlaidSecurity[],
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  if (plaidSecurities.length === 0) return ids;
  const now = deps.now().getTime();
  const today = marketDate(deps.now());

  const existing = await tenant.db
    .select({ id: securities.id, externalId: securities.externalId })
    .from(securities)
    .where(
      tenant.scope(
        securities,
        inArray(
          securities.externalId,
          plaidSecurities.map((security) => security.security_id),
        ),
      ),
    );
  const byExternal = new Map(existing.map((row) => [row.externalId, row.id]));

  for (const security of plaidSecurities) {
    const ticker = security.ticker_symbol?.toUpperCase() ?? null;
    const lastPrice = security.close_price ?? null;
    const lastPriceDate = security.close_price_as_of ?? (lastPrice !== null ? today : null);
    const currency = security.iso_currency_code ?? 'USD';
    const id = byExternal.get(security.security_id);
    if (id) {
      await tenant.db
        .update(securities)
        .set({
          ticker,
          name: security.name,
          type: security.type,
          subtype: security.subtype ?? null,
          currency,
          isPublic: isPublicSecurity(security),
          ...(lastPrice !== null ? { lastPrice, lastPriceDate } : {}),
        })
        .where(tenant.scope(securities, eq(securities.id, id)));
      ids.set(security.security_id, id);
      continue;
    }
    const suggestion = suggestClassification({ ticker, name: security.name, type: security.type, currency });
    const newId = crypto.randomUUID();
    await tenant.db.insert(securities).values({
      id: newId,
      householdId: tenant.householdId,
      externalId: security.security_id,
      ticker,
      name: security.name,
      type: security.type,
      subtype: security.subtype ?? null,
      currency,
      isPublic: isPublicSecurity(security),
      classification: suggestion.classification,
      classificationSource: suggestion.source,
      needsReview: suggestion.needsReview,
      lastPrice,
      lastPriceDate,
      createdAt: now,
    });
    ids.set(security.security_id, newId);
  }
  return ids;
}

async function syncHoldings(
  deps: Deps,
  tenant: Tenant,
  accessToken: string,
  visibleAccounts: Map<string, { id: string; currency: string }>,
): Promise<number> {
  const plaid = requirePlaid(deps);
  const result = await plaid.getHoldings(accessToken);
  const securityIds = await upsertSecurities(deps, tenant, result.securities);
  const now = deps.now().getTime();

  // Unit prices for securities without a public ticker (401(k) trusts etc.).
  const institutionPrices = new Map<string, { price: number; date: string | null }>();

  const rows = result.holdings
    .filter((holding) => visibleAccounts.has(holding.account_id) && securityIds.has(holding.security_id))
    .map((holding) => {
      const account = visibleAccounts.get(holding.account_id)!;
      const securityId = securityIds.get(holding.security_id)!;
      institutionPrices.set(securityId, {
        price: holding.institution_price,
        date: holding.institution_price_as_of ?? null,
      });
      return {
        householdId: tenant.householdId,
        accountId: account.id,
        securityId,
        quantity: holding.quantity,
        price: holding.institution_price,
        priceAsOf: holding.institution_price_as_of ?? null,
        value: toMinor(holding.institution_value),
        costBasis: holding.cost_basis === null || holding.cost_basis === undefined ? null : toMinor(holding.cost_basis),
        currency: holding.iso_currency_code ?? account.currency,
        updatedAt: now,
      };
    });

  const accountIds = [...visibleAccounts.values()].map((account) => account.id);
  if (accountIds.length > 0) {
    await runBatch(tenant.db, [
      tenant.db.delete(holdings).where(tenant.scope(holdings, inArray(holdings.accountId, accountIds))),
      ...chunkRows(holdings, rows).map((chunk) => tenant.db.insert(holdings).values(chunk)),
    ]);
  }

  for (const [securityId, { price, date }] of institutionPrices) {
    await tenant.db
      .update(securities)
      .set({ lastPrice: price, lastPriceDate: date ?? marketDate(deps.now()) })
      .where(tenant.scope(securities, eq(securities.id, securityId), eq(securities.isPublic, false)));
  }
  return rows.length;
}

async function syncInvestmentTransactions(
  deps: Deps,
  tenant: Tenant,
  connection: ConnectionRow,
  accessToken: string,
  visibleAccounts: Map<string, { id: string; currency: string }>,
): Promise<number> {
  const plaid = requirePlaid(deps);
  const today = marketDate(deps.now());
  // Re-fetch a fortnight of overlap: institutions post late.
  const start = connection.txnSyncedThrough
    ? addDays(connection.txnSyncedThrough, -14)
    : addDays(today, -HISTORY_DAYS);

  let offset = 0;
  let stored = 0;
  for (;;) {
    let page;
    try {
      page = await plaid.getInvestmentTransactions(accessToken, start, today, offset);
    } catch (error) {
      // Right after linking Plaid may still be fetching history.
      if (error instanceof PlaidApiError && error.code === 'PRODUCT_NOT_READY') return stored;
      throw error;
    }
    const securityIds = await upsertSecurities(deps, tenant, page.securities);
    const rows = page.investment_transactions
      .filter((txn) => visibleAccounts.has(txn.account_id))
      .map((txn) => ({
        id: crypto.randomUUID(),
        householdId: tenant.householdId,
        accountId: visibleAccounts.get(txn.account_id)!.id,
        externalId: txn.investment_transaction_id,
        securityId: txn.security_id ? (securityIds.get(txn.security_id) ?? null) : null,
        date: txn.date,
        name: txn.name,
        type: txn.type,
        subtype: txn.subtype ?? null,
        quantity: txn.quantity,
        amount: toMinor(txn.amount),
        price: txn.price,
        fees: txn.fees === null || txn.fees === undefined ? null : toMinor(txn.fees),
        currency: txn.iso_currency_code ?? 'USD',
      }));
    await runBatch(
      tenant.db,
      chunkRows(investmentTransactions, rows).map((chunk) =>
        tenant.db
          .insert(investmentTransactions)
          .values(chunk)
          .onConflictDoNothing({ target: [investmentTransactions.accountId, investmentTransactions.externalId] }),
      ),
    );
    stored += rows.length;
    offset += page.investment_transactions.length;
    if (page.investment_transactions.length === 0 || offset >= page.total_investment_transactions) break;
  }

  await tenant.db
    .update(connections)
    .set({ txnSyncedThrough: today })
    .where(tenant.scope(connections, eq(connections.id, connection.id)));
  return stored;
}

/* ------------------------------------------------------------------ */
/* Removal                                                             */
/* ------------------------------------------------------------------ */

/**
 * Disconnect a login. Its accounts and their history are kept (as manual
 * accounts) unless `purge` is set.
 */
export async function removeConnection(
  deps: Deps,
  tenant: Tenant,
  connectionId: string,
  purge: boolean,
): Promise<void> {
  const connection = await getConnection(tenant, connectionId);
  if (!connection) return;
  if (deps.plaid && connection.status !== 'removed') {
    try {
      await deps.plaid.removeItem(await accessTokenFor(deps, connection));
    } catch (error) {
      console.warn('Plaid item removal failed', error instanceof Error ? error.message : error);
    }
  }
  if (purge) {
    await tenant.db.delete(accounts).where(tenant.scope(accounts, eq(accounts.connectionId, connection.id)));
  } else {
    await tenant.db
      .update(accounts)
      .set({ source: 'manual', connectionId: null, externalId: null })
      .where(tenant.scope(accounts, eq(accounts.connectionId, connection.id)));
  }
  // Kept (without its token) so the Items-used count stays accurate: on Plaid's
  // Trial plan a removed Item still uses one of the 10 slots.
  await tenant.db
    .update(connections)
    .set({ status: 'removed', accessTokenEnc: '', assetReportTokenEnc: null, assetReportId: null })
    .where(tenant.scope(connections, eq(connections.id, connection.id)));
}

/** All connections that should be synced by the daily job. */
export async function activeConnections(tenant: Tenant): Promise<ConnectionRow[]> {
  return tenant.db
    .select()
    .from(connections)
    .where(tenant.scope(connections, notInArray(connections.status, ['removed'])));
}

/** Delete stored data for an account that was just hidden. */
export async function purgeAccountData(tenant: Tenant, accountId: string): Promise<void> {
  await tenant.db.delete(holdings).where(tenant.scope(holdings, eq(holdings.accountId, accountId)));
  await tenant.db
    .delete(investmentTransactions)
    .where(tenant.scope(investmentTransactions, eq(investmentTransactions.accountId, accountId)));
}
