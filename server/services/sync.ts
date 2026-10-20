/**
 * Aggregator connections: linking, syncing balances/holdings/investment
 * transactions, and error states. Data for hidden accounts is dropped here —
 * it is never written.
 */
import { eq, inArray, isNull, lte, ne, notInArray, or, sql } from 'drizzle-orm';
import type { AccountBase, Holding, InvestmentTransaction, Security as PlaidSecurity } from 'plaid';
import { suggestClassification } from '../../shared/classify';
import { addDays, marketDate } from '../../shared/dates';
import { toMinor } from '../../shared/money';
import { PlaidApiError, type LinkKind, type PlaidApi } from '../adapters/plaid';
import type { BatchItem } from 'drizzle-orm/batch';
import { chunkRows, inChunks, runAtomic } from '../db/batch';
import { accounts, connections, holdings, investmentTransactions, pricesDaily, securities } from '../db/schema';
import type { Tenant } from '../db/tenant';
import type { Deps } from '../ports';
import { SyncRun, type SyncTrigger } from './activity';
import { collectPendingReport } from './assetReports';
import { runHistoryLoad } from './backfill';
import { BusyError, connectionLease, holdWhile, Lease, snapshotLease } from './lease';
import { decryptToken, encryptToken, loadTokenKeys, tokenAad } from './crypto';
import { stableId } from './ids';
import { closeStatements } from './pricing';

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

/**
 * Store a newly linked login, or the new token for one re-linked in update
 * mode. Returns the connection with its lease held, for the first sync.
 */
export async function linkConnection(
  deps: Deps,
  tenant: Tenant,
  ownerUserId: string,
  publicToken: string,
  kind: LinkKind,
): Promise<{ connection: ConnectionRow; lease: Lease }> {
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

  const now = deps.now().getTime();
  if (existing) {
    const lease = await Lease.acquireOrBusy(deps, tenant, connectionLease(id));
    const run = new SyncRun(deps, tenant, id, 'relink', 'link');
    run.note = 'Signed in again with Plaid Link.';
    await lease.renew();
    await runAtomic(tenant.db, [
      tenant.db
        .update(connections)
        // Re-authenticating resolves login problems and consent warnings.
        .set({ accessTokenEnc, status: 'ok', errorCode: null, statusObservedAt: now, consentExpiresAt, consentWarningAt: null })
        .where(tenant.scope(connections, eq(connections.id, id), ne(connections.status, 'removed'))),
      run.statement(),
    ]);
    return { connection: (await getConnection(tenant, id))!, lease };
  }
  // Nobody can know about this connection yet, so its lease is created held.
  const { lease, statement } = Lease.held(deps, tenant, connectionLease(id));
  await runAtomic(tenant.db, [
    tenant.db.insert(connections).values({
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
      createdAt: now,
    }),
    statement,
  ]);
  return { connection: (await getConnection(tenant, id))!, lease };
}

/* ------------------------------------------------------------------ */
/* Sync                                                                */
/* ------------------------------------------------------------------ */

export interface SyncResult {
  accounts: number;
  holdings: number;
  transactions: number;
  status: ConnectionRow['status'];
  /** The sync didn't run: another was running, or one finished moments ago. */
  skipped?: boolean;
}

export interface SyncOptions {
  /** A lease the caller already holds (re-linking); the sync releases it. */
  lease?: Lease;
  /** Run a due history load at the end (default true; linking runs it separately). */
  history?: boolean;
  /**
   * Skip the Plaid sync if the last one finished this recently (the Sync
   * button). A ready bank-history report is still collected.
   */
  minIntervalMs?: number;
}

/** Minimum gap between button-triggered syncs of one connection. */
export const MANUAL_SYNC_INTERVAL_MS = 2 * 60 * 1000;

const NOTHING = { accounts: 0, holdings: 0, transactions: 0 };

function statusForError(error: unknown): { status: ConnectionRow['status']; code: string } | null {
  if (!(error instanceof PlaidApiError)) return null;
  if (error.code === 'ITEM_LOGIN_REQUIRED' || error.code === 'PENDING_DISCONNECT') {
    return { status: 'login_required', code: error.code };
  }
  if (error.type === 'ITEM_ERROR' || error.type === 'INSTITUTION_ERROR') return { status: 'error', code: error.code };
  return null;
}

/** Plaid said the login needs attention: syncing again can't help until it's fixed. */
const loginBroken = (result: SyncResult) => !result.skipped && result.status !== 'ok';

/**
 * Write a connection's status only if this observation is at least as new as
 * the last one stored: a webhook can report a problem while a sync is
 * running, and that sync's older "OK" mustn't overwrite it. (Syncs of one
 * connection are serialised by its lease, so ties go to the later write.)
 */
export function statusStatement(
  tenant: Tenant,
  connectionId: string,
  values: { status: ConnectionRow['status']; errorCode: string | null },
  observedAt: number,
): BatchItem<'sqlite'> {
  return tenant.db
    .update(connections)
    .set({ ...values, statusObservedAt: observedAt })
    .where(
      tenant.scope(
        connections,
        eq(connections.id, connectionId),
        ne(connections.status, 'removed'),
        or(isNull(connections.statusObservedAt), lte(connections.statusObservedAt, observedAt)),
      ),
    );
}

/**
 * Pull the latest balances (and holdings/transactions for investment logins),
 * then collect any bank-history report Plaid has ready and run any history
 * load that's due.
 *
 * Holds the connection's lease throughout (./lease), so nothing else changes
 * the connection's data meanwhile. Each pass fetches everything from Plaid
 * first, then writes all of it, with its sync-log row, in one atomic batch: a
 * sync applies completely, logged, or not at all.
 */
export async function syncConnection(
  deps: Deps,
  tenant: Tenant,
  connectionId: string,
  trigger: SyncTrigger,
  options: SyncOptions = {},
): Promise<SyncResult> {
  requirePlaid(deps);
  const connection = await getConnection(tenant, connectionId);
  if (!connection) throw new Error('Connection not found.');
  if (connection.status === 'removed') return { ...NOTHING, status: 'removed' };

  const lease = options.lease ?? (await Lease.acquire(deps, tenant, connectionLease(connection.id)));
  if (!lease) {
    // Plaid has news the running work may have fetched too early for: leave
    // a note so the holder syncs again before it finishes.
    if (trigger === 'webhook') await Lease.leaveNote(deps, tenant, connectionLease(connection.id));
    await new SyncRun(deps, tenant, connection.id, 'sync', trigger).skipped(
      trigger === 'webhook' ? 'The connection was busy; it will sync again when that finishes.' : 'The connection was busy (another sync or history load).',
    );
    return { ...NOTHING, status: connection.status, skipped: true };
  }

  return underConnectionLease(deps, tenant, connection.id, trigger, lease, { history: options.history, stopIf: loginBroken }, async () => {
    const now = deps.now().getTime();
    if (options.minIntervalMs && connection.lastSyncedAt && now - connection.lastSyncedAt < options.minIntervalMs) {
      await new SyncRun(deps, tenant, connection.id, 'sync', trigger).skipped(
        `Last synced less than ${Math.round(options.minIntervalMs / 60_000)} minutes ago.`,
      );
      return { ...NOTHING, status: connection.status, skipped: true };
    }
    return syncPass(deps, tenant, connection.id, trigger, lease, lease.abandoned ? "The previous run didn't finish (its lease expired)." : null);
  });
}

/**
 * Run `first` holding the connection's lease, then: collect a ready bank
 * report, run a due history load, and sync again while notes arrive. Every
 * path that changes a connection's data goes through here.
 */
export async function underConnectionLease<T>(
  deps: Deps,
  tenant: Tenant,
  connectionId: string,
  trigger: SyncTrigger,
  lease: Lease,
  options: { history?: boolean; stopIf?: (result: T) => boolean; reportJustRequested?: boolean },
  first: () => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await holdWhile(lease, async (run) => {
    // Stopping releases the lease now (notes stay), so holdWhile ends too.
    if (run === 1) {
      result = await first();
      if (options.stopIf?.(result)) return lease.forceRelease();
    } else {
      const pass = await syncPass(deps, tenant, connectionId, trigger, lease, 'Synced again: Plaid announced new data while the connection was busy.');
      if (loginBroken(pass)) return lease.forceRelease();
    }
    const latest = await getConnection(tenant, connectionId);
    if (!latest || latest.status === 'removed') return;
    // (Not straight after requesting one: Plaid takes a while to build it.)
    if (latest.assetReportTokenEnc && !(run === 1 && options.reportJustRequested)) {
      await collectPendingReport(deps, tenant, latest, trigger, lease);
    }
    const afterReport = await getConnection(tenant, connectionId);
    if (options.history !== false && afterReport && historyDue(afterReport)) {
      await runHistoryLoad(deps, tenant, afterReport.id, trigger, lease, null);
    }
  });
  return result as T;
}

/**
 * A history load is due: never run; abandoned part-way ("running" while we
 * hold the lease means nobody is running it, unless it's a bank connection
 * waiting for its report); or invalidated by a late transaction.
 */
function historyDue(connection: ConnectionRow): boolean {
  if (connection.backfillStatus === 'pending') return true;
  if (connection.backfillStatus === 'running') return connection.assetReportTokenEnc === null;
  return connection.kind === 'investments' && connection.historyStaleAt !== null;
}

/** One fetch-then-write pass. Logs itself; throws (after logging) on unexpected errors. */
async function syncPass(
  deps: Deps,
  tenant: Tenant,
  connectionId: string,
  trigger: SyncTrigger,
  lease: Lease,
  note: string | null,
): Promise<SyncResult> {
  const connection = (await getConnection(tenant, connectionId))!;
  const run = new SyncRun(deps, tenant, connection.id, 'sync', trigger);
  run.note = note;
  const setConnection = (values: Partial<typeof connections.$inferInsert>) =>
    tenant.db.update(connections).set(values).where(tenant.scope(connections, eq(connections.id, connection.id)));
  try {
    let fetched: Fetched;
    const fetchedAt = deps.now().getTime();
    try {
      fetched = await fetchFromPlaid(deps, run.plaid(), connection);
    } catch (error) {
      const mapped = statusForError(error);
      if (!mapped) throw error;
      // Plaid says the login needs attention: record that, nothing else changes.
      run.fail(error);
      await lease.renew();
      await runAtomic(tenant.db, [statusStatement(tenant, connection.id, { status: mapped.status, errorCode: mapped.code }, fetchedAt), run.statement()]);
      return { ...NOTHING, status: mapped.status };
    }

    const writes: BatchItem<'sqlite'>[] = [];
    const visible = await planAccounts(deps, tenant, connection, fetched.accounts, run, writes);
    let holdingCount = 0;
    let transactionCount = 0;
    if (fetched.investments) {
      const securityIds = await planSecurities(deps, tenant, fetched.investments.securities, run, writes);
      holdingCount = await planHoldings(deps, tenant, fetched.investments.holdings, fetched.investments.securities, securityIds, visible, run, writes);
      transactionCount = await planTransactions(deps, tenant, connection, fetched.investments.transactions, securityIds, visible, run, writes);
    }
    writes.push(
      setConnection({
        lastSyncedAt: deps.now().getTime(),
        ...(fetched.investments?.transactionsComplete ? { txnSyncedThrough: marketDate(deps.now()) } : {}),
      }),
      statusStatement(tenant, connection.id, { status: 'ok', errorCode: null }, fetchedAt),
      lease.clearNotesBefore(fetchedAt),
      run.statement(),
    );
    await lease.renew();
    await runAtomic(tenant.db, writes);
    return { accounts: fetched.accounts.length, holdings: holdingCount, transactions: transactionCount, status: 'ok' };
  } catch (error) {
    await run.failed(error);
    throw error;
  }
}

/** Everything one pass needs from Plaid, fetched before anything is written. */
interface Fetched {
  accounts: AccountBase[];
  investments: {
    holdings: Holding[];
    /** From holdings and transaction pages, deduplicated. */
    securities: PlaidSecurity[];
    transactions: InvestmentTransaction[];
    /** False when Plaid is still fetching history (right after linking). */
    transactionsComplete: boolean;
  } | null;
}

async function fetchFromPlaid(deps: Deps, plaid: PlaidApi, connection: ConnectionRow): Promise<Fetched> {
  const accessToken = await accessTokenFor(deps, connection);
  const plaidAccounts = await plaid.getAccounts(accessToken);
  if (connection.kind !== 'investments') return { accounts: plaidAccounts, investments: null };

  const holdingsResult = await plaid.getHoldings(accessToken);
  const allSecurities = new Map(holdingsResult.securities.map((security) => [security.security_id, security]));
  const today = marketDate(deps.now());
  // Re-fetch a fortnight of overlap: institutions post late.
  const start = connection.txnSyncedThrough ? addDays(connection.txnSyncedThrough, -14) : addDays(today, -HISTORY_DAYS);
  const transactions: InvestmentTransaction[] = [];
  let transactionsComplete = true;
  for (let offset = 0; ; ) {
    let page;
    try {
      page = await plaid.getInvestmentTransactions(accessToken, start, today, offset);
    } catch (error) {
      if (error instanceof PlaidApiError && error.code === 'PRODUCT_NOT_READY') {
        transactionsComplete = false;
        break;
      }
      throw error;
    }
    for (const security of page.securities) if (!allSecurities.has(security.security_id)) allSecurities.set(security.security_id, security);
    transactions.push(...page.investment_transactions);
    offset += page.investment_transactions.length;
    if (page.investment_transactions.length === 0 || offset >= page.total_investment_transactions) break;
  }
  return {
    accounts: plaidAccounts,
    investments: { holdings: holdingsResult.holdings, securities: [...allSecurities.values()], transactions, transactionsComplete },
  };
}

/** Visible accounts of a connection: Plaid account_id → Wattle account. */
type VisibleAccounts = Map<string, { id: string; name: string; currency: string }>;

/** The shown name follows the institution's until you rename the account. */
function followPlaidName(plaidName: string) {
  return sql`case when ${accounts.plaidName} is null or ${accounts.name} = ${accounts.plaidName} then ${plaidName} else ${accounts.name} end`;
}

/**
 * Plan inserts for new accounts and updates for existing ones. Returns Plaid
 * account_id → Wattle account for the accounts that are NOT hidden.
 */
async function planAccounts(
  deps: Deps,
  tenant: Tenant,
  connection: ConnectionRow,
  plaidAccounts: AccountBase[],
  run: SyncRun,
  writes: BatchItem<'sqlite'>[],
): Promise<VisibleAccounts> {
  const now = deps.now().getTime();
  const existing = await tenant.db
    .select({
      id: accounts.id,
      externalId: accounts.externalId,
      name: accounts.name,
      isHidden: accounts.isHidden,
      missingSince: accounts.missingSince,
      balance: accounts.balance,
      currency: accounts.currency,
    })
    .from(accounts)
    .where(tenant.scope(accounts, eq(accounts.connectionId, connection.id)));
  const byExternal = new Map(existing.map((row) => [row.externalId, row]));
  const visible: VisibleAccounts = new Map();

  for (const account of plaidAccounts) {
    const currency = account.balances.iso_currency_code ?? 'USD';
    const current = byExternal.get(account.account_id);
    const descriptive = {
      plaidName: account.name,
      officialName: account.official_name ?? null,
      // Plaid's mask is already the last 2–4 characters; never keep more.
      mask: account.mask ? account.mask.slice(-4) : null,
      type: account.type,
      subtype: account.subtype ?? null,
      institutionName: connection.institutionName,
    };
    const balance = plaidBalance(account);

    if (!current) {
      const id = crypto.randomUUID();
      run.change({ kind: 'account_added', accountId: id, account: account.name });
      run.change({ kind: 'balance', accountId: id, account: account.name, before: null, after: balance, currency });
      writes.push(
        tenant.db.insert(accounts).values({
          id,
          householdId: tenant.householdId,
          source: 'plaid',
          connectionId: connection.id,
          externalId: account.account_id,
          name: account.name,
          ...descriptive,
          currency,
          ownerUserId: connection.ownerUserId,
          category: account.type === 'depository' ? 'cash' : null,
          balance,
          balanceAsOf: now,
          createdAt: now,
        }),
      );
      visible.set(account.account_id, { id, name: account.name, currency });
      continue;
    }

    if (current.isHidden) {
      // Keep only the descriptive fields so the account can be recognised and
      // un-hidden; its balance is not stored.
      writes.push(
        tenant.db.update(accounts).set({ ...descriptive, name: followPlaidName(account.name) }).where(tenant.scope(accounts, eq(accounts.id, current.id))),
      );
      continue;
    }
    if (balance !== current.balance || currency !== current.currency) {
      run.change({ kind: 'balance', accountId: current.id, account: account.name, before: current.balance, after: balance, currency });
    }
    writes.push(
      tenant.db
        .update(accounts)
        .set({ ...descriptive, name: followPlaidName(account.name), currency, balance, balanceAsOf: now, missingSince: null })
        .where(tenant.scope(accounts, eq(accounts.id, current.id))),
    );
    visible.set(account.account_id, { id: current.id, name: account.name, currency });
  }
  run.count('accounts', visible.size);

  // Accounts the institution no longer reports (closed, or deselected in
  // Plaid Link): stop counting them, keep their history.
  const reported = new Set(plaidAccounts.map((account) => account.account_id));
  for (const row of existing) {
    if (row.isHidden || reported.has(row.externalId ?? '') || row.missingSince) continue;
    run.change({ kind: 'account_missing', accountId: row.id, account: row.name });
    run.change({ kind: 'balance', accountId: row.id, account: row.name, before: row.balance, after: null, currency: row.currency });
    writes.push(
      tenant.db.update(accounts).set({ missingSince: now, balance: null, balanceAsOf: now }).where(tenant.scope(accounts, eq(accounts.id, row.id))),
      tenant.db.delete(holdings).where(tenant.scope(holdings, eq(holdings.accountId, row.id))),
    );
  }
  return visible;
}

/** Securities exchanges list: stocks and ETFs, whatever else Plaid says. */
const EXCHANGE_TRADED = new Set(['equity', 'etf']);

/**
 * Priced from public market data (daily closes, live quotes) rather than the
 * institution's unit price. Plaid signals it with a previous close, but not
 * every institution (nor its sandbox) sends one, so a stock or ETF with a
 * ticker counts regardless. A mutual fund without a close stays on the
 * institution's price: that's how a private 401(k) trust looks. A ticker the
 * price provider doesn't know still falls back to the institution's price.
 */
function isPublicSecurity(security: PlaidSecurity): boolean {
  const ticker = security.ticker_symbol ?? '';
  if (ticker.length === 0 || ticker.startsWith('CUR:') || security.type === 'cash' || security.type === 'derivative') return false;
  const hasClose = security.close_price !== null && security.close_price !== undefined;
  return hasClose || EXCHANGE_TRADED.has(security.type ?? '');
}

/** Plan upserts for Plaid securities; returns Plaid security_id → Wattle security id. */
async function planSecurities(
  deps: Deps,
  tenant: Tenant,
  plaidSecurities: PlaidSecurity[],
  run: SyncRun,
  writes: BatchItem<'sqlite'>[],
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  if (plaidSecurities.length === 0) return ids;
  const now = deps.now().getTime();
  const today = marketDate(deps.now());

  const byExternal = new Map<string | null, string>();
  for (const chunk of inChunks(plaidSecurities.map((security) => security.security_id))) {
    const rows = await tenant.db
      .select({ id: securities.id, externalId: securities.externalId })
      .from(securities)
      .where(tenant.scope(securities, inArray(securities.externalId, chunk)));
    for (const row of rows) byExternal.set(row.externalId, row.id);
  }

  const inserts: (typeof securities.$inferInsert)[] = [];
  // Plaid's previous close is public market data: store it in the shared
  // price table so the nightly snapshot needn't ask Tiingo for these tickers.
  const closes: (typeof pricesDaily.$inferInsert)[] = [];

  for (const security of plaidSecurities) {
    const ticker = security.ticker_symbol?.toUpperCase() ?? null;
    const lastPrice = security.close_price ?? null;
    const lastPriceDate = security.close_price_as_of ?? (lastPrice !== null ? today : null);
    const currency = security.iso_currency_code ?? 'USD';
    const isPublic = isPublicSecurity(security);
    if (isPublic && ticker && lastPrice !== null && security.close_price_as_of) {
      closes.push({ ticker, date: security.close_price_as_of, close: lastPrice, currency, source: 'plaid' });
    }
    const id = byExternal.get(security.security_id);
    if (id) {
      writes.push(
        tenant.db
          .update(securities)
          .set({
            ticker,
            cusip: security.cusip ?? null,
            isin: security.isin ?? null,
            name: security.name,
            type: security.type,
            subtype: security.subtype ?? null,
            currency,
            isPublic,
            ...(lastPrice !== null ? { lastPrice, lastPriceDate } : {}),
          })
          .where(tenant.scope(securities, eq(securities.id, id))),
      );
      ids.set(security.security_id, id);
      continue;
    }
    const suggestion = suggestClassification({ ticker, name: security.name, type: security.type, currency });
    // Derived, not random: two connections syncing at once that both meet a
    // new security insert the same row (the second insert is ignored).
    const newId = await stableId(`security:${tenant.householdId}:${security.security_id}`);
    inserts.push({
      id: newId,
      householdId: tenant.householdId,
      externalId: security.security_id,
      ticker,
      cusip: security.cusip ?? null,
      isin: security.isin ?? null,
      name: security.name,
      type: security.type,
      subtype: security.subtype ?? null,
      currency,
      isPublic,
      classification: suggestion.classification,
      classificationSource: suggestion.source,
      needsReview: suggestion.needsReview,
      lastPrice,
      lastPriceDate,
      createdAt: now,
    });
    ids.set(security.security_id, newId);
    byExternal.set(security.security_id, newId);
  }
  for (const chunk of chunkRows(securities, inserts)) {
    writes.push(tenant.db.insert(securities).values(chunk).onConflictDoNothing({ target: [securities.householdId, securities.externalId] }));
  }
  // Tiingo's official closes win over Plaid's for the same day.
  writes.push(...closeStatements(deps, closes, { replace: false }));
  run.count('pricesFromPlaid', closes.length);
  return ids;
}

/** Plan the replacement of the visible accounts' holdings, logging what changed. */
async function planHoldings(
  deps: Deps,
  tenant: Tenant,
  plaidHoldings: Holding[],
  plaidSecurities: PlaidSecurity[],
  securityIds: Map<string, string>,
  visibleAccounts: VisibleAccounts,
  run: SyncRun,
  writes: BatchItem<'sqlite'>[],
): Promise<number> {
  const now = deps.now().getTime();
  // Unit prices for securities without a public ticker (401(k) trusts etc.).
  const institutionPrices = new Map<string, { price: number; date: string | null }>();

  const rows = plaidHoldings
    // Some institutions keep reporting fully sold positions with zero units.
    .filter(
      (holding) =>
        visibleAccounts.has(holding.account_id) &&
        securityIds.has(holding.security_id) &&
        (holding.quantity !== 0 || holding.institution_value !== 0),
    )
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
    await recordHoldingChanges(tenant, visibleAccounts, accountIds, rows, plaidSecurities, securityIds, run);
    writes.push(
      tenant.db.delete(holdings).where(tenant.scope(holdings, inArray(holdings.accountId, accountIds))),
      ...chunkRows(holdings, rows).map((chunk) => tenant.db.insert(holdings).values(chunk)),
    );
  }
  // The institution's unit price is the fallback when there's no market
  // close (private funds, or tickers the price provider doesn't know); a
  // previous close from Plaid is better, so that one isn't overwritten.
  const withClose = new Set(
    plaidSecurities.filter((security) => security.close_price !== null && security.close_price !== undefined).map((security) => securityIds.get(security.security_id)),
  );
  for (const [securityId, { price, date }] of institutionPrices) {
    if (withClose.has(securityId)) continue;
    writes.push(
      tenant.db
        .update(securities)
        .set({ lastPrice: price, lastPriceDate: date ?? marketDate(deps.now()) })
        .where(tenant.scope(securities, eq(securities.id, securityId))),
    );
  }
  run.count('holdings', rows.length);
  return rows.length;
}

/** Log units added, changed or removed per holding, comparing with what's stored. */
async function recordHoldingChanges(
  tenant: Tenant,
  visibleAccounts: VisibleAccounts,
  accountIds: string[],
  rows: { accountId: string; securityId: string; quantity: number }[],
  plaidSecurities: PlaidSecurity[],
  securityIds: Map<string, string>,
  run: SyncRun,
): Promise<void> {
  const before = new Map<string, { quantity: number; label: string }>();
  for (const chunk of inChunks(accountIds)) {
    const stored = await tenant.db
      .select({ accountId: holdings.accountId, securityId: holdings.securityId, quantity: holdings.quantity, ticker: securities.ticker, name: securities.name })
      .from(holdings)
      .innerJoin(securities, eq(securities.id, holdings.securityId))
      .where(tenant.scope(holdings, inArray(holdings.accountId, chunk)));
    for (const row of stored) before.set(`${row.accountId}|${row.securityId}`, { quantity: row.quantity, label: row.ticker ?? row.name ?? 'Unknown security' });
  }
  const labels = new Map<string, string>();
  for (const security of plaidSecurities) {
    const id = securityIds.get(security.security_id);
    if (id) labels.set(id, security.ticker_symbol ?? security.name ?? 'Unknown security');
  }
  const accountNames = new Map([...visibleAccounts.values()].map((account) => [account.id, account.name]));
  const after = new Map(rows.map((row) => [`${row.accountId}|${row.securityId}`, row]));

  for (const [key, row] of after) {
    const previous = before.get(key)?.quantity ?? null;
    if (previous !== null && Math.abs(previous - row.quantity) < 1e-9) continue;
    run.change({
      kind: 'holding',
      accountId: row.accountId,
      account: accountNames.get(row.accountId) ?? '',
      security: labels.get(row.securityId) ?? before.get(key)?.label ?? 'Unknown security',
      before: previous,
      after: row.quantity,
    });
  }
  for (const [key, previous] of before) {
    if (after.has(key)) continue;
    const accountId = key.split('|')[0];
    run.change({ kind: 'holding', accountId, account: accountNames.get(accountId) ?? '', security: previous.label, before: previous.quantity, after: null });
  }
}

/**
 * Plan inserts for investment transactions (already-stored ones are left
 * alone). A new one dated before the history was built makes it stale.
 */
async function planTransactions(
  deps: Deps,
  tenant: Tenant,
  connection: ConnectionRow,
  plaidTransactions: InvestmentTransaction[],
  securityIds: Map<string, string>,
  visibleAccounts: VisibleAccounts,
  run: SyncRun,
  writes: BatchItem<'sqlite'>[],
): Promise<number> {
  if (connection.historyAsOf) {
    const known = new Set<string>();
    for (const chunk of inChunks(plaidTransactions.map((txn) => txn.investment_transaction_id))) {
      const rows = await tenant.db
        .select({ externalId: investmentTransactions.externalId })
        .from(investmentTransactions)
        .where(tenant.scope(investmentTransactions, inArray(investmentTransactions.externalId, chunk)));
      for (const row of rows) if (row.externalId) known.add(row.externalId);
    }
    const late = plaidTransactions.filter(
      (txn) => visibleAccounts.has(txn.account_id) && !known.has(txn.investment_transaction_id) && txn.date < connection.historyAsOf!,
    );
    if (late.length > 0) {
      run.count('lateTransactions', late.length);
      run.note = [run.note, `${late.length} transaction(s) dated before the history was built arrived; history will be rebuilt.`].filter(Boolean).join(' ');
      writes.push(
        tenant.db
          .update(connections)
          .set({ historyStaleAt: deps.now().getTime() })
          .where(tenant.scope(connections, eq(connections.id, connection.id))),
      );
    }
  }
  const rows = plaidTransactions
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
  writes.push(
    ...chunkRows(investmentTransactions, rows).map((chunk) =>
      tenant.db
        .insert(investmentTransactions)
        .values(chunk)
        .onConflictDoNothing({ target: [investmentTransactions.accountId, investmentTransactions.externalId] }),
    ),
  );
  run.count('transactions', rows.length);
  return rows.length;
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
  if (!connection || connection.status === 'removed') return;
  // Nothing else may change the connection (or recompute the snapshot from
  // its accounts) meanwhile. Throws BusyError if a sync doesn't finish soon.
  const lease = await Lease.acquireOrBusy(deps, tenant, connectionLease(connection.id));
  const snapshot = await Lease.acquireWaiting(deps, tenant, snapshotLease(tenant.householdId));
  try {
    if (!snapshot) throw new BusyError('The household snapshot is being updated. Try again in a moment.');
    const run = new SyncRun(deps, tenant, connection.id, 'disconnect', 'manual');
    run.note = purge ? 'Disconnected; its accounts and their history were deleted.' : 'Disconnected; its accounts are kept as manual accounts.';
    if (deps.plaid) {
      try {
        await run.plaid().removeItem(await accessTokenFor(deps, connection));
      } catch (error) {
        console.warn('Plaid item removal failed', error instanceof Error ? error.message : error);
      }
    }
    await lease.renew();
    await snapshot.renew();
    await runAtomic(tenant.db, [
      purge
        ? tenant.db.delete(accounts).where(tenant.scope(accounts, eq(accounts.connectionId, connection.id)))
        : tenant.db
            .update(accounts)
            .set({ source: 'manual', connectionId: null, externalId: null })
            .where(tenant.scope(accounts, eq(accounts.connectionId, connection.id))),
      // Kept (without its token) so the Items-used count stays accurate: on
      // Plaid's Trial plan a removed Item still uses one of the 10 slots.
      tenant.db
        .update(connections)
        .set({ status: 'removed', accessTokenEnc: '', assetReportTokenEnc: null, assetReportId: null })
        .where(tenant.scope(connections, eq(connections.id, connection.id))),
      run.statement(),
    ]);
  } finally {
    await snapshot?.forceRelease();
    await lease.forceRelease();
  }
}

/** All connections that should be synced by the daily job. */
export async function activeConnections(tenant: Tenant): Promise<ConnectionRow[]> {
  return tenant.db
    .select()
    .from(connections)
    .where(tenant.scope(connections, notInArray(connections.status, ['removed'])));
}

/** Statements deleting stored data for an account being hidden. */
export function purgeStatements(tenant: Tenant, accountId: string): BatchItem<'sqlite'>[] {
  return [
    tenant.db.delete(holdings).where(tenant.scope(holdings, eq(holdings.accountId, accountId))),
    tenant.db.delete(investmentTransactions).where(tenant.scope(investmentTransactions, eq(investmentTransactions.accountId, accountId))),
  ];
}
