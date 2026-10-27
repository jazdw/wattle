/**
 * An investment account's holdings history from an institution's download:
 * its positions now, then its transactions (a Vanguard download has 18
 * months). Each day's share counts come from walking back from today's
 * positions through the transactions (./backfillCore), priced at the day's
 * close. Shares and cash both move on the trade date, so a purchase never
 * counts the money twice while it settles; bought before the money arrived,
 * cash goes below zero until it does (an amount owed). They're written as imported: trusted over anything from the
 * institution's own feed (shared/quality.ts).
 *
 * Before anything is written the file is checked: every transaction type
 * must be understood, the walk must reach the share counts actually synced
 * on the days since the account was linked, and each trade's price must be
 * close to that day's close. A file that fails writes nothing. Days from the
 * account's first synced one on are left to the snapshots (the check showed
 * they agree). The writing runs as jobs, one window of days each (a load can
 * be thousands of rows).
 */
import { eq, gte, inArray, lte, min, sql } from 'drizzle-orm';
import { suggestClassification } from '../../shared/classify';
import { addDays, dateRange, marketDate, type IsoDate } from '../../shared/dates';
import { leastFinal } from '../../shared/quality';
import type { BatchItem } from 'drizzle-orm/batch';
import { chunkRows, inChunks, runAtomic } from '../db/batch';
import { accountDaily, accounts, holdingDaily, holdings, securities } from '../db/schema';
import type { Tenant } from '../db/tenant';
import { HttpError } from '../lib/http';
import type { Deps } from '../ports';
import { reconstructHistory, type BackfillHolding, type BackfillTransaction } from './backfillCore';
import { BUSY_RETRY_SECONDS, daysPerBlock, PRICE_LOOKBACK_DAYS, windows } from './backfill';
import { stableId } from './ids';
import { enqueue, RetryLater, type JobContext } from './jobRunner';
import { accountLease, connectionLease, Lease } from './lease';
import { closeLookup, describeTickers, ensureCloses } from './pricing';
import { QUALITY_SET, replaceWhere } from './quality';
import { isCashSecurity, priceOn } from './valuation';

/** Transaction types understood (lower case); any other rejects the file. */
const KNOWN_TYPES = new Set([
  'buy',
  'sell',
  'reinvestment',
  'exchange',
  'stock split',
  'dividend',
  'interest',
  'deposit',
  'withdrawal',
  'funds received',
  'fee',
  'sweep in',
  'sweep out',
  'contribution',
  'conversion (incoming)',
  'conversion (outgoing)',
  'capital gain (lt)',
  'capital gain (st)',
  'distribution',
]);
/** Moves between the account's cash and its settlement fund: both cash, so cash doesn't change. */
const SWEEPS = new Set(['sweep in', 'sweep out']);
const CASH_FUND_TRADES = new Set(['buy', 'sell', 'reinvestment', 'exchange']);
const TRADES = new Set(['buy', 'sell', 'reinvestment']);
/** How far a trade's price may be from the day's close before the file is doubted. */
const PRICE_TOLERANCE = 0.05;
/** Problems listed at most, so a badly mismatched file doesn't make a wall of text. */
const MAX_PROBLEMS = 5;

export interface ImportedHoldings {
  /** Today's positions; a null ticker is cash. */
  positions: { ticker: string | null; shares: number }[];
  /** `amount`: cents the account's cash changed by, as the institution reports it (positive in), on the trade date `date`. */
  transactions: { date: IsoDate; type: string; ticker: string | null; shares: number; price: number; amount: number }[];
}

interface BlockPayload {
  accountId: string;
  start: IsoDate;
  end: IsoDate;
  from: IsoDate;
  to: IsoDate;
  holdings: BackfillHolding[];
  transactions: BackfillTransaction[];
  cashSecurityId: string;
}

/**
 * The household's security for each ticker, adding those it doesn't have yet
 * (described by the market data provider, classified by a best guess).
 */
export async function securitiesForTickers(deps: Deps, tenant: Tenant, currency: string, tickers: string[]): Promise<{ byTicker: Map<string, string>; statements: BatchItem<'sqlite'>[]; created: number }> {
  const securityRows = await tenant.db.select({ id: securities.id, ticker: securities.ticker }).from(securities).where(tenant.scope(securities));
  const byTicker = new Map(securityRows.flatMap((row) => (row.ticker ? [[row.ticker.toUpperCase(), row.id] as const] : [])));
  const missing = [...new Set(tickers.map((ticker) => ticker.toUpperCase()))].filter((ticker) => !byTicker.has(ticker));
  // What each new ticker is (stock, ETF, mutual fund) and its name, once per ticker.
  const descriptions = await describeTickers(deps, missing);
  const statements: BatchItem<'sqlite'>[] = [];
  for (const ticker of missing) {
    const description = descriptions.get(ticker);
    const suggestion = suggestClassification({ ticker, name: description?.name ?? null, type: description?.type ?? null, currency });
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
          currency,
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
  return { byTicker, statements, created: missing.length };
}

/**
 * Check a download against what Wattle knows and queue the jobs writing it.
 * Throws a 409 listing what's wrong (nothing written) when it doesn't check out.
 */
export async function importHoldingsHistory(
  deps: Deps,
  tenant: Tenant,
  account: typeof accounts.$inferSelect,
  file: ImportedHoldings,
): Promise<{ days: number; from: IsoDate; to: IsoDate; newSecurities: number }> {
  const unknown = [...new Set(file.transactions.map((txn) => txn.type.toLowerCase()))].filter((type) => !KNOWN_TYPES.has(type));
  if (unknown.length > 0) throw new HttpError(409, `The file has transaction types Wattle doesn't understand yet: ${unknown.join(', ')}. Nothing was imported.`);

  // The account's cash: its cash security (a money market settlement fund, or Plaid's CUR:USD).
  const securityRows = await tenant.db
    .select({ id: securities.id, ticker: securities.ticker, type: securities.type, isPublic: securities.isPublic })
    .from(securities)
    .where(tenant.scope(securities));
  const cashTickers = new Set(securityRows.filter((row) => row.ticker && isCashSecurity(row)).map((row) => row.ticker!.toUpperCase()));
  const isCash = (ticker: string | null) => ticker === null || cashTickers.has(ticker.toUpperCase());
  const held = await tenant.db
    .select({ securityId: holdings.securityId, type: securities.type, ticker: securities.ticker })
    .from(holdings)
    .innerJoin(securities, eq(securities.id, holdings.securityId))
    .where(tenant.scope(holdings, eq(holdings.accountId, account.id)));
  const statements: BatchItem<'sqlite'>[] = [];
  let cashSecurityId = held.find((row) => isCashSecurity(row))?.securityId;
  if (!cashSecurityId) {
    cashSecurityId = await stableId(`security:manual:${tenant.householdId}:CUR:${account.currency}`);
    statements.push(
      tenant.db
        .insert(securities)
        .values({
          id: cashSecurityId,
          householdId: tenant.householdId,
          ticker: `CUR:${account.currency}`,
          name: 'Cash',
          type: 'cash',
          currency: account.currency,
          isPublic: false,
          classification: { categories: { cash: 1 } },
          classificationSource: 'heuristic',
          needsReview: false,
          createdAt: deps.now().getTime(),
        })
        .onConflictDoNothing(),
    );
  }

  const tickers = [...file.positions, ...file.transactions].flatMap((row) => (row.ticker && !isCash(row.ticker) ? [row.ticker.toUpperCase()] : []));
  const found = await securitiesForTickers(deps, tenant, account.currency, tickers);
  statements.push(...found.statements);
  const securityOf = (ticker: string) => found.byTicker.get(ticker.toUpperCase())!;

  // Positions and transactions as the walk back takes them: shares per security, cash in cents (positive out).
  const cashUnits = file.positions.filter((row) => isCash(row.ticker)).reduce((sum, row) => sum + row.shares, 0);
  const holdingsNow: BackfillHolding[] = [
    ...file.positions.filter((row) => !isCash(row.ticker)).map((row) => ({ securityId: securityOf(row.ticker!), quantity: row.shares })),
    { securityId: cashSecurityId, quantity: cashUnits },
  ];
  const transactions: BackfillTransaction[] = file.transactions.flatMap((txn) => {
    const type = txn.type.toLowerCase();
    const cash = isCash(txn.ticker);
    const cashIn = SWEEPS.has(type) || (cash && CASH_FUND_TRADES.has(type)) ? 0 : type === 'fee' ? -Math.abs(txn.amount) : txn.amount;
    const quantity = cash ? 0 : txn.shares;
    if (quantity === 0 && cashIn === 0) return [];
    return [{ date: txn.date, securityId: cash ? null : securityOf(txn.ticker!), quantity, amount: -cashIn }];
  });

  const today = marketDate(deps.now());
  const start = transactions.map((txn) => txn.date).sort()[0];
  const [first] = await tenant.db
    .select({ date: min(accountDaily.date) })
    .from(accountDaily)
    .where(tenant.scope(accountDaily, eq(accountDaily.accountId, account.id), eq(accountDaily.source, 'snapshot')));
  const firstSynced = first?.date ?? null;
  const cutoff = firstSynced ? addDays(firstSynced, -1) : addDays(today, -1);
  if (!start || cutoff < start) throw new HttpError(409, 'The file has no days before Wattle started syncing this account. Nothing was imported.');

  const problems: string[] = [];
  const priced = [...new Set(holdingsNow.map((row) => row.securityId).concat(transactions.flatMap((txn) => (txn.securityId ? [txn.securityId] : []))))];
  const priceTickers = securityRows.filter((row) => priced.includes(row.id) && row.isPublic && row.ticker).map((row) => row.ticker!);
  // New securities aren't in securityRows yet: they're all public tickers.
  const newTickers = [...found.byTicker.entries()].filter(([, id]) => !securityRows.some((row) => row.id === id)).map(([ticker]) => ticker);
  const gaps = await ensureCloses(deps, [...priceTickers, ...newTickers], start, today);
  if (gaps.failed.length > 0 || gaps.rateLimited) throw new HttpError(409, `Prices couldn't be fetched${gaps.failed.length > 0 ? ` for ${gaps.failed.join(', ')}` : ''}. Try again later; nothing was imported.`);

  const tickerOf = new Map([...found.byTicker.entries()].map(([ticker, id]) => [id, ticker]));
  // (a) Since the link: the walk reaches the share counts actually synced.
  if (firstSynced) {
    const walked = reconstructHistory({ start, end: today, emitFrom: firstSynced, emitTo: today, holdings: holdingsNow, transactions, cashSecurityId, allowNegativeCash: true, price: () => ({ price: 1, source: 'close' }) });
    const synced = await tenant.db
      .select({ date: holdingDaily.date, securityId: holdingDaily.securityId, quantity: holdingDaily.quantity })
      .from(holdingDaily)
      .where(tenant.scope(holdingDaily, eq(holdingDaily.accountId, account.id), eq(holdingDaily.source, 'snapshot'), gte(holdingDaily.date, firstSynced)));
    for (const day of walked) {
      const actual = synced.filter((row) => row.date === day.date);
      if (actual.length === 0) continue;
      const ids = new Set([...actual.map((row) => row.securityId), ...day.positions.map((position) => position.securityId)]);
      for (const id of ids) {
        const fromFile = day.positions.find((position) => position.securityId === id)?.quantity ?? 0;
        const fromSync = actual.find((row) => row.securityId === id)?.quantity ?? 0;
        if (Math.abs(fromFile - fromSync) > 0.001) problems.push(`on ${day.date}, ${id === cashSecurityId ? 'cash' : (tickerOf.get(id) ?? 'a holding')} is ${fromFile} in the file but ${fromSync} synced`);
      }
    }
  }
  // (b) Each trade's price is close to that day's close.
  const closes = await closeLookup(deps, [...priceTickers, ...newTickers], addDays(start, -PRICE_LOOKBACK_DAYS), today);
  for (const txn of file.transactions) {
    if (!txn.ticker || isCash(txn.ticker) || !TRADES.has(txn.type.toLowerCase()) || txn.price <= 0) continue;
    const close = closes(txn.ticker.toUpperCase(), txn.date);
    if (close && Math.abs(txn.price - close) / close > PRICE_TOLERANCE) problems.push(`on ${txn.date}, ${txn.ticker} traded at ${txn.price} but closed at ${close}`);
  }
  if (problems.length > 0) {
    const listed = problems.slice(0, MAX_PROBLEMS).join('; ');
    throw new HttpError(409, `The file doesn't match what's known about this account: ${listed}${problems.length > MAX_PROBLEMS ? ` (and ${problems.length - MAX_PROBLEMS} more)` : ''}. Nothing was imported.`);
  }

  // Checked: add any new securities, then write the days as jobs, one window each.
  if (statements.length > 0) await runAtomic(tenant.db, statements);
  const runId = crypto.randomUUID();
  const size = daysPerBlock(deps, priced.length);
  await enqueue(
    deps,
    tenant,
    windows(start, cutoff, size).map(([from, to]) => {
      const block: BlockPayload = { accountId: account.id, start, end: today, from, to, holdings: holdingsNow, transactions, cashSecurityId };
      return { id: `import:${runId}:block:${from}`, type: 'import_block' as const, payload: { ...block }, connectionId: account.connectionId };
    }),
  );
  return { days: dateRange(start, cutoff).length, from: start, to: cutoff, newSecurities: found.created };
}

/** import_block: one window of an imported account's days, walked back and written as imported. */
export async function importBlock({ deps, tenant, job, renew }: JobContext): Promise<Record<string, unknown>> {
  const block = job.payload as unknown as BlockPayload;
  const [account] = await tenant.db.select().from(accounts).where(tenant.scope(accounts, eq(accounts.id, block.accountId)));
  if (!account || account.isHidden) return { days: 0 };
  const involved = [...new Set([...block.holdings.map((row) => row.securityId), ...block.transactions.flatMap((txn) => (txn.securityId ? [txn.securityId] : []))])];
  const securityRows = [];
  for (const chunk of inChunks(involved)) {
    securityRows.push(
      ...(await tenant.db
        .select({ id: securities.id, ticker: securities.ticker, type: securities.type, isPublic: securities.isPublic, lastPrice: securities.lastPrice, lastPriceDate: securities.lastPriceDate })
        .from(securities)
        .where(tenant.scope(securities, inArray(securities.id, chunk)))),
    );
  }
  const securityById = new Map(securityRows.map((row) => [row.id, row]));
  const tickers = securityRows.flatMap((row) => (row.isPublic && row.ticker ? [row.ticker] : []));
  const closes = await closeLookup(deps, tickers, addDays(block.from, -PRICE_LOOKBACK_DAYS), block.to);
  // No split factors: the download records each split as a transaction.
  const days = reconstructHistory({
    start: block.start,
    end: block.end,
    emitFrom: block.from,
    emitTo: block.to,
    holdings: block.holdings,
    transactions: block.transactions,
    cashSecurityId: block.cashSecurityId,
    // The institution's own records: cash below zero is an amount owed (a fee charged before money arrived), not a gap.
    allowNegativeCash: true,
    price: (securityId, date) => {
      const security = securityById.get(securityId);
      return security ? priceOn(security, date, closes) : null;
    },
  });
  const holdingRows = days.flatMap((day) =>
    day.positions.map((position) => ({
      householdId: tenant.householdId,
      accountId: account.id,
      securityId: position.securityId,
      date: day.date,
      quantity: position.quantity,
      price: position.price,
      value: position.value,
      currency: account.currency,
      source: 'import' as const,
      priceSource: position.priceSource,
      unmatched: day.unmatched,
    })),
  );
  const accountRows = days.map((day) => ({
    householdId: tenant.householdId,
    accountId: account.id,
    date: day.date,
    balance: day.total,
    currency: account.currency,
    source: 'import' as const,
    priceSource: leastFinal(day.positions.map((position) => position.priceSource)),
    unmatched: day.unmatched,
  }));

  const lease = await Lease.acquireWaiting(deps, tenant, account.connectionId ? connectionLease(account.connectionId) : accountLease(account.id));
  if (!lease) throw new RetryLater(BUSY_RETRY_SECONDS, 'The account is busy.');
  try {
    await renew();
    await lease.renew();
    await runAtomic(tenant.db, [
      // Positions rebuilt, carried or imported before for these days give way: the file says what was held.
      tenant.db
        .delete(holdingDaily)
        .where(tenant.scope(holdingDaily, eq(holdingDaily.accountId, account.id), gte(holdingDaily.date, block.from), lte(holdingDaily.date, block.to), inArray(holdingDaily.source, ['rebuilt', 'carried', 'import']))),
      ...chunkRows(holdingDaily, holdingRows).map((chunk) =>
        tenant.db
          .insert(holdingDaily)
          .values(chunk)
          .onConflictDoUpdate({
            target: [holdingDaily.accountId, holdingDaily.securityId, holdingDaily.date],
            set: { quantity: sql`excluded.quantity`, price: sql`excluded.price`, value: sql`excluded.value`, ...QUALITY_SET },
            setWhere: replaceWhere(holdingDaily.source),
          }),
      ),
      ...chunkRows(accountDaily, accountRows).map((chunk) =>
        tenant.db
          .insert(accountDaily)
          .values(chunk)
          .onConflictDoUpdate({
            target: [accountDaily.accountId, accountDaily.date],
            set: { balance: sql`excluded.balance`, ...QUALITY_SET },
            setWhere: replaceWhere(accountDaily.source),
          }),
      ),
    ]);
  } finally {
    await lease.forceRelease();
  }
  return { days: accountRows.length };
}
