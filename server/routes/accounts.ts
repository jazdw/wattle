/** Connections, accounts (Plaid and manual), manual balances and holdings. */
import { and, count, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { suggestClassification } from '../../shared/classify';
import { marketDate } from '../../shared/dates';
import { convertMinor, toMinor } from '../../shared/money';
import {
  accountPatchSchema,
  balanceEntrySchema,
  manualAccountSchema,
  manualHoldingsSchema,
} from '../../shared/schemas';
import type { AccountsResponse, AccountSummary, ConnectionsResponse } from '../../shared/types';
import { requireAuth } from '../auth/routes';
import type { BatchItem } from 'drizzle-orm/batch';
import { chunkRows, inChunks, runAtomic } from '../db/batch';
import {
  accountDaily,
  accounts,
  connections,
  holdingDaily,
  holdings,
  householdMembers,
  households,
  securities,
} from '../db/schema';
import type { Tenant } from '../db/tenant';
import type { AppEnv } from '../env';
import { HttpError, notFound, readBody, requestCurrency } from '../lib/http';
import type { Deps, SecurityDescription } from '../ports';
import { connectionActivity, SyncRun } from '../services/activity';
import { backfillConnection } from '../services/backfill';
import { toCurrency } from '../services/portfolio';
import { closeLookup, describeTickers, ensureRecentCloses, fxLookup } from '../services/pricing';
import { snapshotHousehold } from '../services/snapshots';
import { accountLease, connectionLease, Lease, snapshotLease } from '../services/lease';
import { stableId } from '../services/ids';
import { getConnection, MANUAL_SYNC_INTERVAL_MS, purgeStatements, removeConnection, syncConnection, underConnectionLease } from '../services/sync';

const LIABILITY_TYPES = new Set(['credit', 'loan']);

async function householdCurrency(tenant: Tenant): Promise<string> {
  const [row] = await tenant.db
    .select({ currency: households.displayCurrency })
    .from(households)
    .where(eq(households.id, tenant.householdId));
  return row?.currency ?? 'USD';
}

/* ------------------------------------------------------------------ */
/* Connections                                                         */
/* ------------------------------------------------------------------ */

export const connectionRoutes = new Hono<AppEnv>();
connectionRoutes.use('*', requireAuth);

/** Plaid warned the consent is ending, or it ends within a week. */
function consentEnding(row: { consentWarningAt: number | null; consentExpiresAt: number | null }, now: number): boolean {
  return row.consentWarningAt !== null || (row.consentExpiresAt !== null && row.consentExpiresAt - now < 7 * 24 * 3600 * 1000);
}

connectionRoutes.get('/', async (c) => {
  const tenant = c.get('tenant');
  const rows = await tenant.db
    .select()
    .from(connections)
    .where(tenant.scope(connections))
    .orderBy(connections.createdAt);
  const response: ConnectionsResponse = {
    connections: rows
      .filter((row) => row.status !== 'removed')
      .map((row) => ({
        id: row.id,
        institutionName: row.institutionName,
        kind: row.kind,
        hasInvestments: row.hasInvestments,
        hasBalanceHistory: row.hasBalanceHistory,
        // A consent warning shows while the login otherwise works; a login
        // problem takes precedence.
        status: row.status === 'ok' && consentEnding(row, c.env.deps.now().getTime()) ? 'pending_expiration' : row.status,
        errorCode: row.errorCode,
        ownerUserId: row.ownerUserId,
        lastSyncedAt: row.lastSyncedAt,
        backfillStatus: row.backfillStatus,
        consentExpiresAt: row.consentExpiresAt,
        createdAt: row.createdAt,
      })),
    plaidEnv: c.env.deps.plaid?.env ?? null,
    itemsUsed: rows.length,
  };
  return c.json(response);
});

/**
 * Sync now. Within the cooldown it skips the Plaid sync but still collects a
 * ready bank-history report (whose webhook was missed, or can't reach local dev).
 */
connectionRoutes.post('/:id/sync', async (c) => {
  const deps = c.env.deps;
  const tenant = c.get('tenant');
  const connection = await getConnection(tenant, c.req.param('id'));
  if (!connection) notFound('Connection not found.');
  const result = await syncConnection(deps, tenant, connection.id, 'manual', { minIntervalMs: MANUAL_SYNC_INTERVAL_MS });
  await snapshotHousehold(deps, tenant, marketDate(deps.now()));
  return c.json(result);
});

/** The connection's sync log, newest first. */
connectionRoutes.get('/:id/activity', async (c) => {
  const tenant = c.get('tenant');
  const connection = await getConnection(tenant, c.req.param('id'));
  if (!connection) notFound('Connection not found.');
  return c.json({ runs: await connectionActivity(tenant, connection.id) });
});

connectionRoutes.post('/:id/backfill', async (c) => {
  const deps = c.env.deps;
  const tenant = c.get('tenant');
  const connection = await getConnection(tenant, c.req.param('id'));
  if (!connection) notFound('Connection not found.');
  const url = new URL(c.req.url);
  const hook = url.protocol === 'https:' ? `${url.origin}/api/plaid/webhook` : null;
  deps.background(backfillConnection(deps, tenant, connection.id, hook, 'manual'));
  return c.json({ ok: true });
});

connectionRoutes.delete('/:id', async (c) => {
  const tenant = c.get('tenant');
  const connection = await getConnection(tenant, c.req.param('id'));
  if (!connection) notFound('Connection not found.');
  await removeConnection(c.env.deps, tenant, connection.id, c.req.query('purge') === '1');
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

export const accountRoutes = new Hono<AppEnv>();
accountRoutes.use('*', requireAuth);

async function getAccount(tenant: Tenant, id: string) {
  const [row] = await tenant.db.select().from(accounts).where(tenant.scope(accounts, eq(accounts.id, id)));
  return row ?? null;
}

async function assertMember(tenant: Tenant, userId: string | null | undefined): Promise<void> {
  if (!userId) return;
  const [row] = await tenant.db
    .select({ userId: householdMembers.userId })
    .from(householdMembers)
    .where(and(eq(householdMembers.householdId, tenant.householdId), eq(householdMembers.userId, userId)));
  if (!row) throw new HttpError(400, 'Owner must be a household member.');
}

accountRoutes.get('/', async (c) => {
  const deps = c.env.deps;
  const tenant = c.get('tenant');
  const currency = requestCurrency(c, await householdCurrency(tenant));
  const today = marketDate(deps.now());
  const rates = (await fxLookup(deps, today, today))(today);

  const rows = await tenant.db
    .select()
    .from(accounts)
    .where(tenant.scope(accounts))
    .orderBy(accounts.sort, accounts.createdAt);
  const holdingCounts = await tenant.db
    .select({ accountId: holdings.accountId, count: count() })
    .from(holdings)
    .where(tenant.scope(holdings))
    .groupBy(holdings.accountId);
  const countBy = new Map(holdingCounts.map((row) => [row.accountId, row.count]));
  const duplicates = possibleDuplicates(rows);

  const response: AccountsResponse = {
    accounts: rows.map(
      (row): AccountSummary => ({
        id: row.id,
        source: row.source,
        connectionId: row.connectionId,
        institutionName: row.institutionName,
        name: row.name,
        officialName: row.officialName,
        mask: row.mask,
        type: row.type,
        subtype: row.subtype,
        currency: toCurrency(row.currency),
        ownerUserId: row.ownerUserId,
        isHidden: row.isHidden,
        category: row.category as AccountSummary['category'],
        balance: row.isHidden ? null : row.balance,
        balanceAsOf: row.balanceAsOf,
        missingSince: row.missingSince,
        displayBalance:
          row.isHidden || row.balance === null
            ? null
            : convertMinor(row.balance, toCurrency(row.currency), currency, rates),
        holdingCount: countBy.get(row.id) ?? 0,
        possibleDuplicateOf: duplicates.get(row.id) ?? null,
      }),
    ),
  };
  return c.json(response);
});

/**
 * Linked accounts that look like the same account linked through two logins
 * (a joint account each of you linked): same type, subtype, currency and
 * current balance, and the same last four digits (or name, without them).
 * Maps each later-linked copy to the first one.
 */
export function possibleDuplicates(
  rows: { id: string; source: string; connectionId: string | null; isHidden: boolean; missingSince: number | null; type: string; subtype: string | null; currency: string; balance: number | null; mask: string | null; plaidName: string | null; name: string; createdAt: number }[],
): Map<string, string> {
  const first = new Map<string, { id: string; connectionId: string }>();
  const duplicates = new Map<string, string>();
  const candidates = rows
    .filter((row) => row.source === 'plaid' && row.connectionId && !row.isHidden && !row.missingSince && row.balance !== null)
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const row of candidates) {
    const key = [row.type, row.subtype, row.currency, row.balance, row.mask ? `mask:${row.mask}` : `name:${row.plaidName ?? row.name}`].join('|');
    const seen = first.get(key);
    if (!seen) first.set(key, { id: row.id, connectionId: row.connectionId! });
    else if (seen.connectionId !== row.connectionId) duplicates.set(row.id, seen.id);
  }
  return duplicates;
}

function signedBalance(type: string, amount: number): number {
  const minor = toMinor(amount);
  return LIABILITY_TYPES.has(type) ? -Math.abs(minor) : minor;
}

accountRoutes.post('/', async (c) => {
  const deps = c.env.deps;
  const tenant = c.get('tenant');
  const body = await readBody(c, manualAccountSchema);
  await assertMember(tenant, body.ownerUserId);
  const now = deps.now().getTime();
  const id = crypto.randomUUID();
  const balance = body.balance === undefined ? null : signedBalance(body.type, body.balance);
  // The account and its opening balance together, or neither.
  const statements: BatchItem<'sqlite'>[] = [];
  statements.push(tenant.db.insert(accounts).values({
    id,
    householdId: tenant.householdId,
    source: 'manual',
    name: body.name,
    institutionName: body.institutionName ?? null,
    type: body.type,
    currency: body.currency,
    category: body.category ?? null,
    ownerUserId: body.ownerUserId ?? null,
    balance,
    balanceAsOf: balance === null ? null : now,
    createdAt: now,
  }));
  if (balance !== null) {
    statements.push(
      tenant.db.insert(accountDaily).values({
        householdId: tenant.householdId,
        accountId: id,
        date: body.date ?? marketDate(deps.now()),
        balance,
        currency: body.currency,
        source: 'manual',
      }),
    );
  }
  await runAtomic(tenant.db, statements);
  return c.json({ id }, 201);
});

/**
 * Edit an account. Renaming, owner and category are single updates. Hiding or
 * un-hiding changes what syncs store and what the snapshot counts, so it holds
 * the connection's lease (linked accounts) and the snapshot's, taken in that
 * order everywhere; it answers 409 if a sync doesn't finish soon.
 */
accountRoutes.patch('/:id', async (c) => {
  const deps = c.env.deps;
  const tenant = c.get('tenant');
  const account = await getAccount(tenant, c.req.param('id'));
  if (!account) notFound('Account not found.');
  const body = await readBody(c, accountPatchSchema);
  await assertMember(tenant, body.ownerUserId);

  const update: Partial<typeof accounts.$inferInsert> = {};
  if (body.name !== undefined) update.name = body.name;
  if (body.ownerUserId !== undefined) update.ownerUserId = body.ownerUserId;
  if (body.category !== undefined) update.category = body.category;
  if (body.currency !== undefined && account.source === 'manual') update.currency = body.currency;
  if (body.isHidden !== undefined) {
    update.isHidden = body.isHidden;
    if (body.isHidden) {
      // Stop holding the hidden account's numbers.
      update.balance = null;
      update.balanceAsOf = null;
    }
  }
  const statements: BatchItem<'sqlite'>[] = [];
  if (Object.keys(update).length > 0) {
    statements.push(tenant.db.update(accounts).set(update).where(tenant.scope(accounts, eq(accounts.id, account.id))));
  }
  if (body.isHidden) {
    statements.push(...purgeStatements(tenant, account.id));
    if (body.purge) {
      statements.push(
        tenant.db.delete(accountDaily).where(tenant.scope(accountDaily, eq(accountDaily.accountId, account.id))),
        tenant.db.delete(holdingDaily).where(tenant.scope(holdingDaily, eq(holdingDaily.accountId, account.id))),
      );
    }
  }
  const changesVisibility = body.isHidden !== undefined && body.isHidden !== account.isHidden;
  if (!changesVisibility) {
    await runAtomic(tenant.db, statements);
    return c.json({ ok: true });
  }

  const connectionId = account.connectionId;
  const connection = connectionId ? await Lease.acquireOrBusy(deps, tenant, connectionLease(connectionId)) : null;
  let snapshot: Lease;
  try {
    snapshot = await Lease.acquireOrBusy(deps, tenant, snapshotLease(tenant.householdId), 'The household snapshot is being updated. Try again in a moment.');
  } catch (error) {
    await connection?.forceRelease();
    throw error;
  }
  try {
    const write = async () => {
      const run = connectionId ? new SyncRun(deps, tenant, connectionId, 'account', 'manual') : null;
      if (run) run.note = `${body.isHidden ? 'Hid' : 'Un-hid'} “${account.name}”${body.isHidden && body.purge ? ' and deleted its stored history' : ''}.`;
      await connection?.renew();
      await snapshot.renew();
      await runAtomic(tenant.db, [...statements, ...(run ? [run.statement()] : [])]);
    };
    if (connection && connectionId) await underConnectionLease(deps, tenant, connectionId, 'manual', connection, { history: false }, write);
    else await write();
  } finally {
    await snapshot.forceRelease();
  }
  // Totals changed; this also runs any snapshot that was asked for meanwhile.
  await snapshotHousehold(deps, tenant, marketDate(deps.now()));
  return c.json({ ok: true });
});

accountRoutes.delete('/:id', async (c) => {
  const tenant = c.get('tenant');
  const account = await getAccount(tenant, c.req.param('id'));
  if (!account) notFound('Account not found.');
  if (account.source !== 'manual') {
    throw new HttpError(409, 'Linked accounts are hidden, not deleted. Remove the connection to delete them.');
  }
  // Not while a holdings save or balance entry for it is mid-way.
  const lease = await Lease.acquireOrBusy(c.env.deps, tenant, accountLease(account.id), 'Someone else is updating this account. Try again in a moment.');
  try {
    await lease.renew();
    await tenant.db.delete(accounts).where(tenant.scope(accounts, eq(accounts.id, account.id)));
  } finally {
    await lease.forceRelease();
  }
  return c.json({ ok: true });
});

/** Dated balance for a manual account (property, super, AU bank…). */
accountRoutes.post('/:id/balances', async (c) => {
  const deps = c.env.deps;
  const tenant = c.get('tenant');
  const account = await getAccount(tenant, c.req.param('id'));
  if (!account) notFound('Account not found.');
  if (account.source !== 'manual') throw new HttpError(409, 'Linked account balances come from the institution.');
  const body = await readBody(c, balanceEntrySchema);
  const balance = signedBalance(account.type, body.balance);

  // One change to the account at a time (two entries at once could otherwise
  // leave the older one as the current balance), written atomically.
  const lease = await Lease.acquireOrBusy(deps, tenant, accountLease(account.id), 'Someone else is updating this account. Try again in a moment.');
  let isLatest = false;
  try {
    // The account's current balance is its most recent entry (recorded or imported).
    const [latest] = await tenant.db
      .select({ date: accountDaily.date })
      .from(accountDaily)
      .where(tenant.scope(accountDaily, eq(accountDaily.accountId, account.id), inArray(accountDaily.source, ['manual', 'import'])))
      .orderBy(desc(accountDaily.date))
      .limit(1);
    isLatest = !latest || body.date >= latest.date;
    const statements: BatchItem<'sqlite'>[] = [
      tenant.db
        .insert(accountDaily)
        .values({ householdId: tenant.householdId, accountId: account.id, date: body.date, balance, currency: account.currency, source: 'manual' })
        .onConflictDoUpdate({ target: [accountDaily.accountId, accountDaily.date], set: { balance, source: 'manual', estimated: false } }),
    ];
    if (isLatest) {
      statements.push(
        tenant.db.update(accounts).set({ balance, balanceAsOf: deps.now().getTime() }).where(tenant.scope(accounts, eq(accounts.id, account.id))),
        // Carried-forward snapshot copies after this date are stale now.
        tenant.db
          .delete(accountDaily)
          .where(tenant.scope(accountDaily, eq(accountDaily.accountId, account.id), eq(accountDaily.source, 'sync'), sql`${accountDaily.date} > ${body.date}`)),
      );
    }
    await lease.renew();
    await runAtomic(tenant.db, statements);
  } finally {
    await lease.forceRelease();
  }
  if (isLatest) await snapshotHousehold(deps, tenant, marketDate(deps.now()));
  return c.json({ ok: true });
});

accountRoutes.get('/:id/balances', async (c) => {
  const tenant = c.get('tenant');
  const account = await getAccount(tenant, c.req.param('id'));
  if (!account) notFound('Account not found.');
  const rows = await tenant.db
    .select({ date: accountDaily.date, balance: accountDaily.balance, source: accountDaily.source })
    .from(accountDaily)
    .where(tenant.scope(accountDaily, eq(accountDaily.accountId, account.id), ne(accountDaily.source, 'sync')))
    .orderBy(desc(accountDaily.date))
    .limit(100);
  return c.json({ balances: rows });
});

accountRoutes.get('/:id/holdings', async (c) => {
  const tenant = c.get('tenant');
  const account = await getAccount(tenant, c.req.param('id'));
  if (!account) notFound('Account not found.');
  const rows = await tenant.db
    .select({
      ticker: securities.ticker,
      name: securities.name,
      quantity: holdings.quantity,
      price: holdings.price,
      value: holdings.value,
      isPublic: securities.isPublic,
    })
    .from(holdings)
    .innerJoin(securities, and(eq(securities.id, holdings.securityId), eq(securities.householdId, holdings.householdId)))
    .where(tenant.scope(holdings, eq(holdings.accountId, account.id)))
    .orderBy(desc(holdings.value));
  // The editor sends this back, so a save can't silently overwrite a newer one.
  return c.json({ holdings: rows, version: account.holdingsVersion });
});

/**
 * Replace a manual account's holdings (ticker + quantity, optional unit price).
 * One save at a time per account (its lease); `version` must match what the
 * editor loaded, else 409 (someone saved in between). Securities, holdings and
 * the new version are written in one atomic batch.
 */
accountRoutes.put('/:id/holdings', async (c) => {
  const deps = c.env.deps;
  const tenant = c.get('tenant');
  const account = await getAccount(tenant, c.req.param('id'));
  if (!account) notFound('Account not found.');
  if (account.source !== 'manual') throw new HttpError(409, 'Linked account holdings come from the institution.');
  const body = await readBody(c, manualHoldingsSchema);
  const today = marketDate(deps.now());

  // Prices first (their own logged, atomic writes), outside the lease.
  const tickers = body.holdings.filter((holding) => holding.price === undefined).map((holding) => holding.ticker.toUpperCase());
  await ensureRecentCloses(deps, tickers, today);
  const closes = await closeLookup(deps, tickers, today, today);
  // What each new ticker is (stock, ETF, mutual fund): it decides live quotes
  // and helps classify it. Once per ticker; a type you set is kept.
  const descriptions = await describeTickers(deps, await untypedTickers(tenant, body.holdings.map((holding) => holding.ticker)));

  const lease = await Lease.acquireOrBusy(deps, tenant, accountLease(account.id), 'Someone else is saving these holdings. Try again in a moment.');
  let unpriced = 0;
  try {
    const [current] = await tenant.db
      .select({ holdingsVersion: accounts.holdingsVersion })
      .from(accounts)
      .where(tenant.scope(accounts, eq(accounts.id, account.id)));
    if (!current) notFound('Account not found.');
    if (body.version !== current.holdingsVersion) {
      throw new HttpError(409, 'These holdings were changed by someone else. Reload to see their changes.');
    }

    const statements: BatchItem<'sqlite'>[] = [];
    const rows: (typeof holdings.$inferInsert)[] = [];
    for (const entry of body.holdings) {
      const securityId = await planManualSecurity(deps, tenant, entry, account.currency, closes(entry.ticker, today), descriptions.get(entry.ticker.toUpperCase()), statements);
      const price = entry.price ?? closes(entry.ticker, today) ?? 0;
      if (price === 0) unpriced += 1;
      rows.push({
        householdId: tenant.householdId,
        accountId: account.id,
        securityId,
        quantity: entry.quantity,
        price,
        priceAsOf: today,
        value: Math.round(entry.quantity * price * 100),
        currency: account.currency,
        updatedAt: deps.now().getTime(),
      });
    }
    statements.push(
      tenant.db.delete(holdings).where(tenant.scope(holdings, eq(holdings.accountId, account.id))),
      ...chunkRows(holdings, rows).map((chunk) => tenant.db.insert(holdings).values(chunk)),
      tenant.db
        .update(accounts)
        .set({ holdingsVersion: current.holdingsVersion + 1 })
        .where(tenant.scope(accounts, eq(accounts.id, account.id))),
    );
    await lease.renew();
    await runAtomic(tenant.db, statements);
  } finally {
    await lease.forceRelease();
  }
  await snapshotHousehold(deps, tenant, today);
  return c.json({ ok: true, unpriced });
});

/** Of these tickers, those with no security of known type in the household (to look up). */
export async function untypedTickers(tenant: Tenant, tickers: string[]): Promise<string[]> {
  const wanted = [...new Set(tickers.map((ticker) => ticker.toUpperCase()))];
  const typed = new Set<string>();
  for (const chunk of inChunks(wanted)) {
    const rows = await tenant.db
      .select({ ticker: securities.ticker })
      .from(securities)
      .where(tenant.scope(securities, inArray(securities.ticker, chunk), isNotNull(securities.type)));
    for (const row of rows) if (row.ticker) typed.add(row.ticker.toUpperCase());
  }
  return wanted.filter((ticker) => !typed.has(ticker));
}

/**
 * Plan the security for a manually entered ticker; returns its id. Reuses the
 * household's security for that ticker (so its classification is shared), but
 * never changes one that belongs to a Plaid connection: the next sync would
 * overwrite it. A new one gets an id derived from the ticker, so two saves
 * at once create one row.
 */
async function planManualSecurity(
  deps: Deps,
  tenant: Tenant,
  entry: { ticker: string; name?: string; price?: number },
  currency: string,
  close: number | null,
  description: SecurityDescription | undefined,
  statements: BatchItem<'sqlite'>[],
): Promise<string> {
  const ticker = entry.ticker.toUpperCase();
  const candidates = await tenant.db
    .select({ id: securities.id, externalId: securities.externalId, type: securities.type, name: securities.name })
    .from(securities)
    .where(tenant.scope(securities, eq(securities.ticker, ticker)));
  const manual = candidates.find((row) => row.externalId === null);
  const linked = candidates.find((row) => row.externalId !== null);
  const isPublic = entry.price === undefined && close !== null;
  const priceFields = entry.price !== undefined ? { lastPrice: entry.price, lastPriceDate: marketDate(deps.now()) } : {};
  if (manual) {
    statements.push(
      tenant.db
        .update(securities)
        .set({
          ...(entry.name ? { name: entry.name } : {}),
          ...priceFields,
          ...(isPublic ? { isPublic } : {}),
          ...(manual.type === null && description ? { type: description.type } : {}),
          // A name that's still just the ticker gets the looked-up one.
          ...(!entry.name && manual.name === ticker && description?.name ? { name: description.name } : {}),
        })
        .where(tenant.scope(securities, eq(securities.id, manual.id))),
    );
    return manual.id;
  }
  // A public fund also held through Plaid: share its row (and classification).
  if (linked && entry.price === undefined) return linked.id;
  const name = entry.name ?? description?.name ?? ticker;
  const suggestion = suggestClassification({ ticker, name, type: description?.type ?? null, currency });
  const id = await stableId(`security:manual:${tenant.householdId}:${ticker}`);
  statements.push(
    tenant.db
      .insert(securities)
      .values({
        id,
        householdId: tenant.householdId,
        ticker,
        name,
        type: description?.type ?? null,
        currency,
        isPublic,
        classification: suggestion.classification,
        classificationSource: suggestion.source,
        needsReview: suggestion.needsReview,
        ...priceFields,
        createdAt: deps.now().getTime(),
      })
      .onConflictDoNothing(),
  );
  return id;
}
