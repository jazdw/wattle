/** Portfolio views: summary, history, securities, targets, quotes, imports, settings. */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { suggestClassification } from '../../shared/classify';
import { marketDate } from '../../shared/dates';
import { toMinor } from '../../shared/money';
import {
  householdPatchSchema,
  importBalancesSchema,
  importHoldingsSchema,
  securityPatchSchema,
  targetSchema,
} from '../../shared/schemas';
import type { HistoryGroup, QuotesResponse, SecurityRow, TargetResponse } from '../../shared/types';
import { normalizeWeights, type Category } from '../../shared/taxonomy';
import { requireAuth } from '../auth/routes';
import { chunkRows, runBatch } from '../db/batch';
import { accountDaily, accounts, holdingDaily, holdings, households, pricesDaily, securities, targets } from '../db/schema';
import type { Tenant } from '../db/tenant';
import type { AppEnv } from '../env';
import { HttpError, notFound, readBody, requestCurrency } from '../lib/http';
import { cacheGet, cacheSet } from '../services/cache';
import { loadHistory, RANGES, type Range } from '../services/history';
import { activeTarget, loadPortfolio } from '../services/portfolio';
import { snapshotHousehold } from '../services/snapshots';
import { activeConnections, syncConnection } from '../services/sync';

export const portfolioRoutes = new Hono<AppEnv>();
portfolioRoutes.use('*', requireAuth);

async function householdCurrency(tenant: Tenant): Promise<string> {
  const [row] = await tenant.db
    .select({ currency: households.displayCurrency })
    .from(households)
    .where(eq(households.id, tenant.householdId));
  return row?.currency ?? 'USD';
}

portfolioRoutes.get('/portfolio', async (c) => {
  const tenant = c.get('tenant');
  const currency = requestCurrency(c, await householdCurrency(tenant));
  return c.json(await loadPortfolio(c.env.deps, tenant, currency));
});

const GROUPS: HistoryGroup[] = ['total', 'account', 'category', 'holding'];

portfolioRoutes.get('/history', async (c) => {
  const tenant = c.get('tenant');
  const currency = requestCurrency(c, await householdCurrency(tenant));
  const range = (RANGES as readonly string[]).includes(c.req.query('range') ?? '') ? (c.req.query('range') as Range) : '1Y';
  const group = GROUPS.includes(c.req.query('group') as HistoryGroup) ? (c.req.query('group') as HistoryGroup) : 'total';
  const accountId = c.req.query('accountId') || undefined;
  if (group === 'holding' && !accountId) throw new HttpError(400, 'accountId is required for holdings.');
  return c.json(await loadHistory(c.env.deps, tenant, { range, group, currency, accountId }));
});

/** Sync every connection now (rate-limited per connection) and refresh today's snapshot. */
portfolioRoutes.post('/refresh', async (c) => {
  const deps = c.env.deps;
  const tenant = c.get('tenant');
  const now = deps.now().getTime();
  const results = [];
  for (const connection of await activeConnections(tenant)) {
    if (connection.lastSyncedAt && now - connection.lastSyncedAt < 2 * 60 * 1000) continue;
    try {
      results.push(await syncConnection(deps, tenant, connection.id));
    } catch (error) {
      console.error('Refresh sync failed', error instanceof Error ? error.message : error);
    }
  }
  await snapshotHousehold(deps, tenant, marketDate(deps.now()));
  return c.json({ synced: results.length });
});

/* ------------------------------------------------------------------ */
/* Securities & classification                                         */
/* ------------------------------------------------------------------ */

portfolioRoutes.get('/securities', async (c) => {
  const tenant = c.get('tenant');
  const rows = await tenant.db
    .select({
      id: securities.id,
      ticker: securities.ticker,
      name: securities.name,
      type: securities.type,
      isPublic: securities.isPublic,
      classification: securities.classification,
      classificationSource: securities.classificationSource,
      needsReview: securities.needsReview,
    })
    .from(securities)
    .where(tenant.scope(securities))
    .orderBy(securities.ticker);
  return c.json({ securities: rows satisfies SecurityRow[] });
});

portfolioRoutes.patch('/securities/:id', async (c) => {
  const tenant = c.get('tenant');
  const body = await readBody(c, securityPatchSchema);
  const classification = {
    categories: normalizeWeights(body.classification.categories),
    ...(body.classification.sizes ? { sizes: normalizeWeights(body.classification.sizes) } : {}),
    ...(body.classification.styles ? { styles: normalizeWeights(body.classification.styles) } : {}),
  };
  if (Object.keys(classification.categories).length === 0) throw new HttpError(400, 'Give at least one category weight.');
  const result = await tenant.db
    .update(securities)
    .set({ classification, classificationSource: 'user', needsReview: false })
    .where(tenant.scope(securities, eq(securities.id, c.req.param('id'))))
    .returning({ id: securities.id });
  if (result.length === 0) notFound('Security not found.');
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Target allocation                                                   */
/* ------------------------------------------------------------------ */

portfolioRoutes.get('/targets', async (c) => {
  const target = await activeTarget(c.get('tenant'));
  const response: TargetResponse = {
    target: target
      ? {
          id: target.id,
          name: target.name,
          weights: target.weights as Partial<Record<Category, number>>,
          bandPct: target.bandPct,
          excludedAccountIds: target.excludedAccountIds,
          excludedCategories: target.excludedCategories as Category[],
        }
      : null,
  };
  return c.json(response);
});

portfolioRoutes.put('/targets', async (c) => {
  const deps = c.env.deps;
  const tenant = c.get('tenant');
  const body = await readBody(c, targetSchema);
  const weights = normalizeWeights(body.weights);
  if (Object.keys(weights).length === 0) throw new HttpError(400, 'Give at least one target weight.');
  const values = {
    name: body.name,
    weights,
    bandPct: body.bandPct,
    excludedAccountIds: body.excludedAccountIds,
    excludedCategories: body.excludedCategories,
    updatedAt: deps.now().getTime(),
  };
  const existing = await activeTarget(tenant);
  if (existing) {
    await tenant.db.update(targets).set(values).where(tenant.scope(targets, eq(targets.id, existing.id)));
  } else {
    await tenant.db.insert(targets).values({ id: crypto.randomUUID(), householdId: tenant.householdId, isActive: true, ...values });
  }
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Live quotes                                                         */
/* ------------------------------------------------------------------ */

const QUOTE_TTL_SECONDS = 60;
const LIVE_TYPES = new Set(['equity', 'etf']);

portfolioRoutes.get('/quotes', async (c) => {
  const deps = c.env.deps;
  const tenant = c.get('tenant');
  const rows = await tenant.db
    .selectDistinct({ ticker: securities.ticker, type: securities.type })
    .from(securities)
    .innerJoin(holdings, and(eq(holdings.securityId, securities.id), eq(holdings.householdId, securities.householdId)))
    .innerJoin(accounts, and(eq(accounts.id, holdings.accountId), eq(accounts.isHidden, false)))
    .where(tenant.scope(securities, eq(securities.isPublic, true)));

  const response: QuotesResponse = { quotes: [], closes: [] };
  const closeTickers: string[] = [];
  for (const row of rows) {
    if (!row.ticker) continue;
    if (!deps.quotes || !LIVE_TYPES.has(row.type ?? '')) {
      closeTickers.push(row.ticker);
      continue;
    }
    const key = `quote:${row.ticker}`;
    let quote = await cacheGet<QuotesResponse['quotes'][number]>(deps, key);
    if (!quote) {
      try {
        quote = await deps.quotes.quote(row.ticker);
      } catch (error) {
        console.warn('Quote failed', row.ticker, error instanceof Error ? error.message : error);
      }
      if (quote) await cacheSet(deps, key, quote, QUOTE_TTL_SECONDS);
    }
    if (quote) response.quotes.push(quote);
    else closeTickers.push(row.ticker);
  }

  if (closeTickers.length > 0) {
    // Latest close per ticker (mutual funds strike NAV once a day).
    const latest = await deps.db
      .select({ ticker: pricesDaily.ticker, date: sql<string>`max(${pricesDaily.date})` })
      .from(pricesDaily)
      .where(inArray(pricesDaily.ticker, closeTickers))
      .groupBy(pricesDaily.ticker);
    for (const { ticker, date } of latest) {
      const [row] = await deps.db
        .select({ close: pricesDaily.close })
        .from(pricesDaily)
        .where(and(eq(pricesDaily.ticker, ticker), eq(pricesDaily.date, date)));
      if (row) response.closes.push({ ticker, close: row.close, date });
    }
  }
  return c.json(response);
});

/* ------------------------------------------------------------------ */
/* CSV imports (parsed in the browser, validated here)                 */
/* ------------------------------------------------------------------ */

async function importTarget(tenant: Tenant, accountId: string) {
  const [account] = await tenant.db.select().from(accounts).where(tenant.scope(accounts, eq(accounts.id, accountId)));
  if (!account) notFound('Account not found.');
  if (account.isHidden) throw new HttpError(409, 'Un-hide the account before importing into it.');
  return account;
}

portfolioRoutes.post('/imports/balances', async (c) => {
  const tenant = c.get('tenant');
  const body = await readBody(c, importBalancesSchema);
  const account = await importTarget(tenant, body.accountId);
  const liability = account.type === 'credit' || account.type === 'loan';
  // Last value wins when a file has several rows for one day.
  const byDate = new Map(body.rows.map((row) => [row.date, row.balance]));
  const rows = [...byDate].map(([date, balance]) => ({
    householdId: tenant.householdId,
    accountId: account.id,
    date,
    balance: liability ? -Math.abs(toMinor(balance)) : toMinor(balance),
    currency: account.currency,
    source: 'import' as const,
  }));
  await runBatch(
    tenant.db,
    chunkRows(accountDaily, rows).map((chunk) =>
      tenant.db
        .insert(accountDaily)
        .values(chunk)
        .onConflictDoUpdate({
          target: [accountDaily.accountId, accountDaily.date],
          set: { balance: sql`excluded.balance`, source: sql`excluded.source`, estimated: sql`0` },
          // Imports fill gaps and replace estimates; with overwrite they replace synced values too.
          setWhere: body.overwrite
            ? sql`1 = 1`
            : sql`${accountDaily.source} = 'backfill' or ${accountDaily.source} = 'import'`,
        }),
    ),
  );
  return c.json({ imported: rows.length });
});

portfolioRoutes.post('/imports/holdings', async (c) => {
  const deps = c.env.deps;
  const tenant = c.get('tenant');
  const body = await readBody(c, importHoldingsSchema);
  const account = await importTarget(tenant, body.accountId);

  const securityRows = await tenant.db
    .select({ id: securities.id, ticker: securities.ticker })
    .from(securities)
    .where(tenant.scope(securities));
  const byTicker = new Map(securityRows.map((row) => [row.ticker?.toUpperCase(), row.id]));
  const missing = [...new Set(body.rows.map((row) => row.ticker.toUpperCase()))].filter((ticker) => !byTicker.has(ticker));
  for (const ticker of missing) {
    const suggestion = suggestClassification({ ticker, name: null, type: null, currency: account.currency });
    const id = crypto.randomUUID();
    await tenant.db.insert(securities).values({
      id,
      householdId: tenant.householdId,
      ticker,
      name: ticker,
      currency: account.currency,
      isPublic: true,
      classification: suggestion.classification,
      classificationSource: suggestion.source,
      needsReview: suggestion.needsReview,
      createdAt: deps.now().getTime(),
    });
    byTicker.set(ticker, id);
  }

  const holdingRows = body.rows.map((row) => ({
    householdId: tenant.householdId,
    accountId: account.id,
    securityId: byTicker.get(row.ticker.toUpperCase())!,
    date: row.date,
    quantity: row.quantity,
    price: row.price ?? null,
    value: row.price !== undefined ? Math.round(row.quantity * row.price * 100) : 0,
    currency: account.currency,
    source: 'import' as const,
    estimated: row.price === undefined,
  }));
  await runBatch(
    tenant.db,
    chunkRows(holdingDaily, holdingRows).map((chunk) =>
      tenant.db
        .insert(holdingDaily)
        .values(chunk)
        .onConflictDoUpdate({
          target: [holdingDaily.accountId, holdingDaily.securityId, holdingDaily.date],
          set: {
            quantity: sql`excluded.quantity`,
            price: sql`excluded.price`,
            value: sql`excluded.value`,
            source: sql`excluded.source`,
            estimated: sql`excluded.estimated`,
          },
          setWhere: body.overwrite ? sql`1 = 1` : sql`${holdingDaily.source} in ('backfill', 'import')`,
        }),
    ),
  );
  return c.json({ imported: holdingRows.length, newSecurities: missing.length });
});

/* ------------------------------------------------------------------ */
/* Household settings                                                  */
/* ------------------------------------------------------------------ */

portfolioRoutes.patch('/household', async (c) => {
  const tenant = c.get('tenant');
  const body = await readBody(c, householdPatchSchema);
  if (Object.keys(body).length > 0) {
    await tenant.db.update(households).set(body).where(eq(households.id, tenant.householdId));
  }
  return c.json({ ok: true });
});
