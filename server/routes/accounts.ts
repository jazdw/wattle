/** Connections, accounts (Plaid and manual), manual balances and holdings. */
import { and, count, desc, eq, ne, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { suggestClassification } from '../../shared/classify';
import { addDays, marketDate } from '../../shared/dates';
import { convertMinor, toMinor } from '../../shared/money';
import {
  accountPatchSchema,
  balanceEntrySchema,
  manualAccountSchema,
  manualHoldingsSchema,
} from '../../shared/schemas';
import type { AccountsResponse, AccountSummary, ConnectionsResponse } from '../../shared/types';
import { requireAuth } from '../auth/routes';
import { chunkRows, runBatch } from '../db/batch';
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
import type { Deps } from '../ports';
import { backfillConnection } from '../services/backfill';
import { toCurrency } from '../services/portfolio';
import { closeLookup, ensureCloses, fxLookup } from '../services/pricing';
import { snapshotHousehold } from '../services/snapshots';
import { getConnection, purgeAccountData, removeConnection, syncConnection } from '../services/sync';

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
        status: row.status,
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

/** Minimum gap between manual syncs of one connection. */
const SYNC_COOLDOWN_MS = 2 * 60 * 1000;

connectionRoutes.post('/:id/sync', async (c) => {
  const deps = c.env.deps;
  const tenant = c.get('tenant');
  const connection = await getConnection(tenant, c.req.param('id'));
  if (!connection) notFound('Connection not found.');
  if (connection.lastSyncedAt && deps.now().getTime() - connection.lastSyncedAt < SYNC_COOLDOWN_MS) {
    return c.json({ status: connection.status, skipped: true });
  }
  const result = await syncConnection(deps, tenant, connection.id);
  await snapshotHousehold(deps, tenant, marketDate(deps.now()));
  return c.json(result);
});

connectionRoutes.post('/:id/backfill', async (c) => {
  const deps = c.env.deps;
  const tenant = c.get('tenant');
  const connection = await getConnection(tenant, c.req.param('id'));
  if (!connection) notFound('Connection not found.');
  const url = new URL(c.req.url);
  const hook = url.protocol === 'https:' ? `${url.origin}/api/plaid/webhook` : null;
  deps.background(backfillConnection(deps, tenant, connection.id, hook));
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
        displayBalance:
          row.isHidden || row.balance === null
            ? null
            : convertMinor(row.balance, toCurrency(row.currency), currency, rates),
        holdingCount: countBy.get(row.id) ?? 0,
      }),
    ),
  };
  return c.json(response);
});

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
  await tenant.db.insert(accounts).values({
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
  });
  if (balance !== null) {
    await tenant.db.insert(accountDaily).values({
      householdId: tenant.householdId,
      accountId: id,
      date: body.date ?? marketDate(deps.now()),
      balance,
      currency: body.currency,
      source: 'manual',
    });
  }
  return c.json({ id }, 201);
});

accountRoutes.patch('/:id', async (c) => {
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
  if (Object.keys(update).length > 0) {
    await tenant.db.update(accounts).set(update).where(tenant.scope(accounts, eq(accounts.id, account.id)));
  }
  if (body.isHidden) {
    await purgeAccountData(tenant, account.id);
    if (body.purge) {
      await tenant.db.delete(accountDaily).where(tenant.scope(accountDaily, eq(accountDaily.accountId, account.id)));
      await tenant.db.delete(holdingDaily).where(tenant.scope(holdingDaily, eq(holdingDaily.accountId, account.id)));
    }
  }
  return c.json({ ok: true });
});

accountRoutes.delete('/:id', async (c) => {
  const tenant = c.get('tenant');
  const account = await getAccount(tenant, c.req.param('id'));
  if (!account) notFound('Account not found.');
  if (account.source !== 'manual') {
    throw new HttpError(409, 'Linked accounts are hidden, not deleted. Remove the connection to delete them.');
  }
  await tenant.db.delete(accounts).where(tenant.scope(accounts, eq(accounts.id, account.id)));
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

  await tenant.db
    .insert(accountDaily)
    .values({
      householdId: tenant.householdId,
      accountId: account.id,
      date: body.date,
      balance,
      currency: account.currency,
      source: 'manual',
    })
    .onConflictDoUpdate({
      target: [accountDaily.accountId, accountDaily.date],
      set: { balance, source: 'manual', estimated: false },
    });

  // The account's current balance is its most recent entry.
  const [latest] = await tenant.db
    .select({ date: accountDaily.date, balance: accountDaily.balance })
    .from(accountDaily)
    .where(tenant.scope(accountDaily, eq(accountDaily.accountId, account.id), eq(accountDaily.source, 'manual')))
    .orderBy(desc(accountDaily.date))
    .limit(1);
  if (latest?.date === body.date) {
    await tenant.db
      .update(accounts)
      .set({ balance, balanceAsOf: deps.now().getTime() })
      .where(tenant.scope(accounts, eq(accounts.id, account.id)));
    // Carried-forward copies after this date are stale now.
    await tenant.db
      .delete(accountDaily)
      .where(
        tenant.scope(
          accountDaily,
          eq(accountDaily.accountId, account.id),
          sql`${accountDaily.date} > ${body.date}`,
        ),
      );
    await snapshotHousehold(deps, tenant, marketDate(deps.now()));
  }
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
  return c.json({ holdings: rows });
});

/** Replace a manual account's holdings (ticker + quantity, optional unit price). */
accountRoutes.put('/:id/holdings', async (c) => {
  const deps = c.env.deps;
  const tenant = c.get('tenant');
  const account = await getAccount(tenant, c.req.param('id'));
  if (!account) notFound('Account not found.');
  if (account.source !== 'manual') throw new HttpError(409, 'Linked account holdings come from the institution.');
  const body = await readBody(c, manualHoldingsSchema);
  const today = marketDate(deps.now());

  const tickers = body.holdings.filter((holding) => holding.price === undefined).map((holding) => holding.ticker.toUpperCase());
  await ensureCloses(deps, tickers, addDays(today, -7), today);
  const closes = await closeLookup(deps, tickers, today, today);

  const rows: (typeof holdings.$inferInsert)[] = [];
  for (const entry of body.holdings) {
    const securityId = await upsertManualSecurity(deps, tenant, entry, account.currency, closes(entry.ticker, today));
    const price = entry.price ?? closes(entry.ticker, today) ?? 0;
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
  await runBatch(tenant.db, [
    tenant.db.delete(holdings).where(tenant.scope(holdings, eq(holdings.accountId, account.id))),
    ...chunkRows(holdings, rows).map((chunk) => tenant.db.insert(holdings).values(chunk)),
  ]);
  await snapshotHousehold(deps, tenant, today);
  return c.json({ ok: true, unpriced: rows.filter((row) => row.price === 0).length });
});

async function upsertManualSecurity(
  deps: Deps,
  tenant: Tenant,
  entry: { ticker: string; name?: string; price?: number },
  currency: string,
  close: number | null,
): Promise<string> {
  const ticker = entry.ticker.toUpperCase();
  const [existing] = await tenant.db
    .select({ id: securities.id })
    .from(securities)
    .where(tenant.scope(securities, eq(securities.ticker, ticker)))
    .limit(1);
  const isPublic = entry.price === undefined && close !== null;
  const priceFields =
    entry.price !== undefined ? { lastPrice: entry.price, lastPriceDate: marketDate(deps.now()) } : {};
  if (existing) {
    await tenant.db
      .update(securities)
      .set({ ...(entry.name ? { name: entry.name } : {}), ...priceFields, ...(isPublic ? { isPublic } : {}) })
      .where(tenant.scope(securities, eq(securities.id, existing.id)));
    return existing.id;
  }
  const suggestion = suggestClassification({ ticker, name: entry.name ?? null, type: null, currency });
  const id = crypto.randomUUID();
  await tenant.db.insert(securities).values({
    id,
    householdId: tenant.householdId,
    ticker,
    name: entry.name ?? ticker,
    currency,
    isPublic,
    classification: suggestion.classification,
    classificationSource: suggestion.source,
    needsReview: suggestion.needsReview,
    ...priceFields,
    createdAt: deps.now().getTime(),
  });
  return id;
}
