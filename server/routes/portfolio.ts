/** Portfolio views: summary, history, securities, targets, quotes, imports, settings. */
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { suggestClassification } from '../../shared/classify';
import { marketDate, newYorkClock } from '../../shared/dates';
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
import type { BatchItem } from 'drizzle-orm/batch';
import { chunkRows, inChunks, runAtomic } from '../db/batch';
import { accounts, holdingDaily, holdings, households, pricesDaily, securities, targets } from '../db/schema';
import type { Tenant } from '../db/tenant';
import type { AppEnv } from '../env';
import { HttpError, notFound, readBody, requestCurrency } from '../lib/http';
import { cacheGetMany, cacheSetMany } from '../services/cache';
import { loadHistory, RANGES, type Range } from '../services/history';
import { activeTarget, loadPortfolio } from '../services/portfolio';
import { stableId } from '../services/ids';
import { Lease, targetsLease } from '../services/lease';
import { writeBalances } from '../services/balances';
import { describeTickers } from '../services/pricing';
import { snapshotHousehold } from '../services/snapshots';
import { activeConnections, MANUAL_SYNC_INTERVAL_MS, syncConnection } from '../services/sync';
import { describeError } from '../lib/errors';

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
  let synced = 0;
  for (const connection of await activeConnections(tenant)) {
    try {
      const result = await syncConnection(deps, tenant, connection.id, 'refresh', { minIntervalMs: MANUAL_SYNC_INTERVAL_MS });
      if (!result.skipped) synced += 1;
    } catch (error) {
      console.error('Refresh sync failed', describeError(error));
    }
  }
  await snapshotHousehold(deps, tenant, marketDate(deps.now()));
  return c.json({ synced });
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
  const [security] = await tenant.db
    .select({ externalId: securities.externalId })
    .from(securities)
    .where(tenant.scope(securities, eq(securities.id, c.req.param('id'))));
  if (!security) notFound('Security not found.');
  // An institution's securities get their type from it on every sync.
  if (body.type !== undefined && security.externalId !== null) {
    throw new HttpError(409, "This security's type comes from the institution.");
  }
  await tenant.db
    .update(securities)
    .set({ classification, classificationSource: 'user', needsReview: false, ...(body.type !== undefined ? { type: body.type } : {}) })
    .where(tenant.scope(securities, eq(securities.id, c.req.param('id'))));
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
          version: target.version,
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
  // One save at a time; refused if someone saved since this editor loaded.
  const lease = await Lease.acquireOrBusy(deps, tenant, targetsLease(tenant.householdId), 'Someone else is saving the target. Try again in a moment.');
  try {
    const existing = await activeTarget(tenant);
    if ((existing?.version ?? undefined) !== body.version) {
      throw new HttpError(409, 'The target was changed by someone else. Reload to see their changes.');
    }
    await lease.renew();
    if (existing) {
      await tenant.db
        .update(targets)
        .set({ ...values, version: existing.version + 1 })
        .where(tenant.scope(targets, eq(targets.id, existing.id), eq(targets.version, existing.version)));
    } else {
      // A derived id: two first saves create one target, not two.
      const id = await stableId(`target:${tenant.householdId}`);
      await tenant.db
        .insert(targets)
        .values({ id, householdId: tenant.householdId, isActive: true, ...values })
        .onConflictDoNothing();
    }
  } finally {
    await lease.forceRelease();
  }
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Live quotes                                                         */
/* ------------------------------------------------------------------ */

/**
 * Live quotes for stocks and ETFs only (tickers entered by hand get their
 * type looked up when added). Mutual funds strike one NAV a day, so they,
 * and anything of unknown type, show their last close instead.
 */
const LIVE_TYPES = new Set(['equity', 'etf']);
const wantsLiveQuote = (type: string | null) => type !== null && LIVE_TYPES.has(type);
/** Per page refresh, for providers with no bulk quote. */
const MAX_SINGLE_QUOTES_PER_REQUEST = 25;

portfolioRoutes.get('/quotes', async (c) => {
  const deps = c.env.deps;
  const tenant = c.get('tenant');
  const rows = await tenant.db
    .selectDistinct({ ticker: securities.ticker, type: securities.type, lastPrice: securities.lastPrice, lastPriceDate: securities.lastPriceDate })
    .from(securities)
    .innerJoin(holdings, and(eq(holdings.securityId, securities.id), eq(holdings.householdId, securities.householdId)))
    .innerJoin(accounts, and(eq(accounts.id, holdings.accountId), eq(accounts.isHidden, false)))
    .where(tenant.scope(securities, eq(securities.isPublic, true)));

  const response: QuotesResponse = { quotes: [], closes: [] };
  const tickers = [...new Map(rows.flatMap((row) => (row.ticker ? [[row.ticker, { ticker: row.ticker, live: Boolean(deps.quotes) && wantsLiveQuote(row.type) }] as const] : []))).values()];
  // A quote is "live" only if it's from today's session (New York); otherwise
  // (weekends, holidays, a fund's last NAV) the last close is shown.
  const today = newYorkClock(deps.now()).date;
  const fromToday = (quote: QuotesResponse['quotes'][number]) => newYorkClock(new Date(quote.time)).date === today;
  const closeTickers = tickers.filter((row) => !row.live).map((row) => row.ticker);

  // Live quotes: cached ones in one query; the stale ones from the provider
  // (one request for all with Tiingo; one per ticker with Finnhub, which has
  // no bulk quote); the new ones cached in one batch.
  const live = tickers.filter((row) => row.live).map((row) => row.ticker);
  const cached = await cacheGetMany<QuotesResponse['quotes'][number]>(deps, live.map((ticker) => `quote:${ticker}`));
  const stale = live.filter((ticker) => !cached.has(`quote:${ticker}`));
  const fetched = new Map<string, QuotesResponse['quotes'][number]>();
  if (deps.quotes && stale.length > 0) {
    const provider = deps.quotes;
    try {
      if (provider.quotes) {
        for (const quote of await provider.quotes(stale)) fetched.set(quote.ticker.toUpperCase(), quote);
      } else {
        // One request per ticker (Finnhub): at most a batch per page refresh,
        // so many tickers never burst past Finnhub's 30 a second or Workers'
        // 50 outbound requests per invocation. The rest show their previous
        // quote or last close, and refresh on the page's next poll.
        for (const ticker of stale.slice(0, MAX_SINGLE_QUOTES_PER_REQUEST)) {
          const quote = await provider.quote(ticker);
          if (quote) fetched.set(ticker.toUpperCase(), quote);
        }
      }
    } catch (error) {
      console.warn('Quotes failed', describeError(error));
    }
  }
  for (const ticker of live) {
    const quote = cached.get(`quote:${ticker}`) ?? fetched.get(ticker.toUpperCase()) ?? null;
    if (quote && fromToday(quote)) response.quotes.push(quote);
    else closeTickers.push(ticker);
  }
  await cacheSetMany(deps, [...fetched].map(([ticker, quote]) => [`quote:${ticker}`, quote]), deps.config.quoteCacheSeconds);

  // Latest close per ticker (mutual funds strike NAV once a day): from the
  // shared price table, or the institution's own last price for this
  // household if that's newer (or the only one; see sharedCloseStatements).
  // SQLite returns the row that holds max(date) for the bare `close` column.
  const marketToday = marketDate(deps.now());
  const latestClose = new Map<string, { ticker: string; date: string; close: number }>();
  for (const row of rows) {
    if (!row.ticker || row.lastPrice === null || !row.lastPriceDate || row.lastPriceDate > marketToday) continue;
    const known = latestClose.get(row.ticker);
    if (!known || row.lastPriceDate > known.date) latestClose.set(row.ticker, { ticker: row.ticker, date: row.lastPriceDate, close: row.lastPrice });
  }
  for (const chunk of inChunks(closeTickers)) {
    const latest = await deps.db
      .select({ ticker: pricesDaily.ticker, date: sql<string>`max(${pricesDaily.date})`, close: pricesDaily.close })
      .from(pricesDaily)
      .where(and(inArray(pricesDaily.ticker, chunk), lte(pricesDaily.date, marketToday)))
      .groupBy(pricesDaily.ticker);
    for (const row of latest) {
      const own = latestClose.get(row.ticker);
      if (!own || row.date >= own.date) latestClose.set(row.ticker, row);
    }
  }
  for (const ticker of closeTickers) {
    const close = latestClose.get(ticker);
    if (close) response.closes.push(close);
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
  const deps = c.env.deps;
  const tenant = c.get('tenant');
  const body = await readBody(c, importBalancesSchema);
  const account = await importTarget(tenant, body.accountId);
  const imported = await writeBalances(deps, tenant, account, body.rows, 'import', body.overwrite);
  return c.json({ imported });
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
  // What each new ticker is (stock, ETF, mutual fund) and its name, once per ticker.
  const descriptions = await describeTickers(deps, missing);
  const statements: BatchItem<'sqlite'>[] = [];
  for (const ticker of missing) {
    const description = descriptions.get(ticker);
    const suggestion = suggestClassification({ ticker, name: description?.name ?? null, type: description?.type ?? null, currency: account.currency });
    // Same derived id as manual holdings use, so concurrent saves share one row.
    const id = await stableId(`security:manual:${tenant.householdId}:${ticker}`);
    statements.push(
      tenant.db
        .insert(securities)
        .values({
          id,
          householdId: tenant.householdId,
          ticker,
          name: description?.name ?? ticker,
          type: description?.type ?? null,
          currency: account.currency,
          isPublic: true,
          classification: suggestion.classification,
          classificationSource: suggestion.source,
          needsReview: suggestion.needsReview,
          createdAt: deps.now().getTime(),
        })
        .onConflictDoNothing(),
    );
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
  // New securities and the whole file together, or none of it.
  await runAtomic(tenant.db, [
    ...statements,
    ...chunkRows(holdingDaily, holdingRows).map((chunk) =>
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
  ]);
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
