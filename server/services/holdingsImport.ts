/**
 * Every import: one or more files, each with one or more accounts, read in
 * the browser into one shape (src/lib/imports.ts) and sent together. Each
 * goes into an account you have, linked or manual, or a new manual one.
 *
 * - Balances (a bank export) are written as they are (./balances).
 * - Holdings (a brokerage or plan download: positions and cash now, then
 *   transactions) give each day's share counts and cash by walking back
 *   from the positions (./backfillCore). Shares and cash both move on the
 *   trade date, so a purchase never counts the money twice while it
 *   settles; bought before the money arrived, cash goes below zero until it
 *   does (an amount owed). Funds with a market ticker are priced at each
 *   day's close; funds without one (a plan's collective trusts), or whose
 *   closes can't be fetched just now, from the file's own prices, on a
 *   straight line between them (fundPrice), marked as estimates.
 *
 * Every account is checked before anything is written, and one that fails
 * stops the whole import: no fund may go below zero shares, a fund priced
 * from the file must have totals that are its shares × price, a buy or sell
 * of a market fund must be near that day's close, and in a linked account
 * the walk must reach the share counts synced since the link. Days from a
 * linked account's first synced one on are left to the snapshots (the check
 * showed they agree); a manual account's file is written through today and
 * its positions become the account's holdings. Imported days are trusted
 * over anything from the institution (shared/quality.ts). The days are
 * written as jobs, one window each (a load can be thousands of rows).
 */
import { and, eq, gte, inArray, lte, min, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { suggestClassification } from '../../shared/classify';
import { addDays, dateRange, marketDate, type IsoDate } from '../../shared/dates';
import { leastFinal } from '../../shared/quality';
import type { ImportedHoldings, ImportKind, ImportRequest } from '../../shared/schemas';
import type { ImportCheck, ImportedAccount, ImportProblem, ImportResponse, TickerSuggestion } from '../../shared/types';
import { chunkRows, inChunks, runAtomic } from '../db/batch';
import { accountDaily, accounts, holdingDaily, holdings, householdMembers, jobs, securities } from '../db/schema';
import type { Tenant } from '../db/tenant';
import { describeError } from '../lib/errors';
import { HttpError, notFound } from '../lib/http';
import type { Deps } from '../ports';
import { reconstructHistory, type BackfillHolding, type BackfillTransaction, type PriceResult } from './backfillCore';
import { BUSY_RETRY_SECONDS, daysPerBlock, PRICE_LOOKBACK_DAYS, windows } from './backfill';
import { writeBalances } from './balances';
import { stableId } from './ids';
import { enqueue, RetryLater, type JobContext } from './jobRunner';
import { accountLease, connectionLease, Lease } from './lease';
import { closeLookup, datedCloseLookup, describeTickers, ensureCloses } from './pricing';
import { QUALITY_SET, replaceWhere } from './quality';
import { importedEstimates, repriced, snapshotHousehold } from './snapshots';
import { isCashSecurity, priceOn } from './valuation';

/** Transactions that move shares (of a fund, or between cash and a money market fund). */
const SHARE_KINDS = new Set<ImportKind>(['buy', 'sell', 'reinvest', 'transfer']);
/** Transactions that only move cash: an account with none of these, and no cash, holds no cash at all. */
const CASH_KINDS = new Set<ImportKind>(['income', 'deposit', 'withdrawal', 'fee', 'sweep']);
/** Trades whose totals are checked: shares × price, give or take rounding and charges. */
const PRICED_KINDS = new Set<ImportKind>(['buy', 'sell', 'reinvest']);
/**
 * Trades whose price is checked against the day's close. Not reinvestments:
 * their price is the dividend over a share count rounded to a few decimals,
 * filled when the dividend is paid, so it can sit well off that day's close.
 */
const TRADES = new Set<ImportKind>(['buy', 'sell']);
/** How far a trade's price may be from the day's close before the file is doubted. */
const PRICE_TOLERANCE = 0.05;
/** Share counts in files are rounded (to 3 or 4 decimals): how far below zero a walk back may go. */
const SHARES_EPSILON = 0.001;
/** Problems listed at most, so a badly mismatched file doesn't make a wall of text. */
const MAX_PROBLEMS = 5;

interface BlockPayload {
  accountId: string;
  start: IsoDate;
  end: IsoDate;
  from: IsoDate;
  to: IsoDate;
  holdings: BackfillHolding[];
  transactions: BackfillTransaction[];
  cashSecurityId: string;
  /** Funds with no market prices: the institution's prices by day, priced between them (fundPrice). */
  prices?: Record<string, [IsoDate, number][]>;
  /** A manual account: the file replaces its snapshot days too (there's no institution feed to keep). */
  replaceSnapshots?: boolean;
}

/**
 * Share counts in files are rounded (to 3 decimals, or 4): a total may be
 * off shares × price by half that rounding's worth of shares, plus a cent.
 * A reinvested dividend's shares are rounded from the dividend, so it's off
 * by a few cents.
 */
const SHARE_ROUNDING = 0.0005;

type Account = typeof accounts.$inferSelect;


/**
 * A fund's price on a day from the institution's prices on others (sorted by
 * day): its own on a day it has one, else on a straight line between the
 * nearest before and after, or the nearest one held beyond the first or last.
 */
export function fundPrice(points: [IsoDate, number][], date: IsoDate): PriceResult | null {
  if (points.length === 0) return null;
  let after = points.findIndex(([day]) => day >= date);
  if (after === -1) after = points.length;
  if (points[after]?.[0] === date) return { price: points[after][1], source: 'institution' };
  const before = points[after - 1];
  const next = points[after];
  if (!before || !next) return { price: (before ?? next)[1], source: 'interpolated' };
  const span = dateRange(before[0], next[0]).length - 1;
  const into = dateRange(before[0], date).length - 1;
  return { price: before[1] + ((next[1] - before[1]) * into) / span, source: 'interpolated' };
}

/**
 * The household's security for each ticker, adding those it doesn't have yet
 * (described by the market data provider, classified by a best guess).
 */
export async function securitiesForTickers(
  deps: Deps,
  tenant: Tenant,
  currency: string,
  tickers: string[],
  /** The file's names by ticker, for tickers the provider can't describe. */
  names: Map<string, string> = new Map(),
): Promise<{ byTicker: Map<string, string>; statements: BatchItem<'sqlite'>[]; created: number }> {
  const securityRows = await tenant.db.select({ id: securities.id, ticker: securities.ticker }).from(securities).where(tenant.scope(securities));
  const byTicker = new Map(securityRows.flatMap((row) => (row.ticker ? [[row.ticker.toUpperCase(), row.id] as const] : [])));
  const missing = [...new Set(tickers.map((ticker) => ticker.toUpperCase()))].filter((ticker) => !byTicker.has(ticker));
  // What each new ticker is (stock, ETF, mutual fund) and its name, once per ticker.
  const descriptions = await describeTickers(deps, missing);
  const statements: BatchItem<'sqlite'>[] = [];
  for (const ticker of missing) {
    const description = descriptions.get(ticker);
    const name = description?.name ?? names.get(ticker) ?? null;
    const suggestion = suggestClassification({ ticker, name, type: description?.type ?? null, currency });
    // Same derived id as manual holdings use, so concurrent saves share one row.
    const id = await stableId(`security:manual:${tenant.householdId}:${ticker}`);
    statements.push(
      tenant.db
        .insert(securities)
        .values({
          id,
          householdId: tenant.householdId,
          ticker,
          name: name ?? ticker,
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

/** An account to import into: yours, and not hidden. */
async function importTarget(tenant: Tenant, accountId: string): Promise<Account> {
  const [account] = await tenant.db.select().from(accounts).where(tenant.scope(accounts, eq(accounts.id, accountId)));
  if (!account) notFound('Account not found.');
  if (account.isHidden) throw new HttpError(409, 'Un-hide the account before importing into it.');
  return account;
}

async function isMember(tenant: Tenant, userId: string): Promise<boolean> {
  const [row] = await tenant.db
    .select({ userId: householdMembers.userId })
    .from(householdMembers)
    .where(and(eq(householdMembers.householdId, tenant.householdId), eq(householdMembers.userId, userId)));
  return Boolean(row);
}

/** What phase 1 decided for one account: written in phase 2, once every account has checked out. */
interface Plan {
  label: string;
  account: Account;
  created: boolean;
  /** Written together: the new account, its securities' prices, the holdings it now has. */
  statements: BatchItem<'sqlite'>[];
  /** An existing manual account whose holdings are replaced: under its lease. */
  replacesHoldings: boolean;
  blocks: BlockPayload[];
  balances?: { date: string; balance: number }[];
  /** Market funds priced from the file, without closes. */
  estimated?: string[];
  /** Each trade's close (by the file's id for the security), for a preview. */
  closes?: { date: string; security: string; close: number }[];
  days: number;
  from: IsoDate;
  to: IsoDate;
}

/**
 * Check every account in an import, then write them all. Throws a 409
 * listing what's wrong, by account, when any doesn't check out (nothing
 * written).
 */
export async function importAccounts(deps: Deps, tenant: Tenant, request: ImportRequest): Promise<ImportResponse> {
  const { plans, shared, problems, today } = await prepareImport(deps, tenant, request);
  stop(problems);

  // Checked: write each account, then queue its days.
  if (shared.length > 0) await runAtomic(tenant.db, shared);
  const results: ImportedAccount[] = [];
  let snapshot = false;
  for (const plan of plans) {
    if (plan.statements.length > 0) {
      const lease = plan.replacesHoldings ? await Lease.acquireOrBusy(deps, tenant, accountLease(plan.account.id), 'Someone else is changing this account. Try again in a moment.') : null;
      try {
        if (plan.replacesHoldings) {
          const [current] = await tenant.db.select({ holdingsVersion: accounts.holdingsVersion }).from(accounts).where(tenant.scope(accounts, eq(accounts.id, plan.account.id)));
          plan.statements.push(tenant.db.update(accounts).set({ holdingsVersion: (current?.holdingsVersion ?? 0) + 1 }).where(tenant.scope(accounts, eq(accounts.id, plan.account.id))));
        }
        await lease?.renew();
        await runAtomic(tenant.db, plan.statements);
      } finally {
        await lease?.forceRelease();
      }
    }
    if (plan.balances) {
      plan.days = await writeBalances(deps, tenant, plan.account, plan.balances, 'import');
    } else {
      const runId = crypto.randomUUID();
      await enqueue(
        deps,
        tenant,
        plan.blocks.map((block) => ({ id: `import:${runId}:block:${block.from}`, type: 'import_block' as const, payload: { ...block }, groupId: `import:${runId}`, connectionId: plan.account.connectionId })),
      );
      snapshot ||= plan.account.source === 'manual';
    }
    results.push({ label: plan.label, accountId: plan.account.id, created: plan.created, days: plan.days, from: plan.from, to: plan.to, estimated: plan.estimated ?? [] });
  }
  // A manual account's holdings changed: today's value follows them.
  if (snapshot) await snapshotHousehold(deps, tenant, today);
  return { accounts: results };
}

/**
 * Check an import without writing anything: what each account would get
 * (days, prices from the file, each trade's close) and every problem found,
 * dated where it's one day's, for a preview.
 */
export async function checkImport(deps: Deps, tenant: Tenant, request: ImportRequest): Promise<ImportCheck> {
  const { plans, problems } = await prepareImport(deps, tenant, request);
  return {
    accounts: plans.map((plan) => ({ label: plan.label, created: plan.created, days: plan.days, from: plan.from, to: plan.to, estimated: plan.estimated ?? [], closes: plan.closes ?? [] })),
    problems,
  };
}

/** Phase 1: every account checked and its writes planned; nothing written. */
async function prepareImport(deps: Deps, tenant: Tenant, request: ImportRequest) {
  const today = marketDate(deps.now());
  const now = deps.now().getTime();
  const problems: ImportProblem[] = [];
  const problem = (label: string, text: string, date: string | null = null) => problems.push({ label, date, text });
  const plans: Plan[] = [];
  const shared: BatchItem<'sqlite'>[] = [];

  // The accounts: yours, or new manual ones (inserted with the rest in phase 2).
  const targets: { entry: ImportRequest['accounts'][number]; account: Account; created: boolean }[] = [];
  const seen = new Set<string>();
  for (const entry of request.accounts) {
    let account: Account;
    let created = false;
    if ('accountId' in entry.target) {
      account = await importTarget(tenant, entry.target.accountId);
      if (seen.has(account.id)) problem(entry.label, `${account.name} is chosen for another account in the files too`);
      seen.add(account.id);
    } else {
      const fresh = entry.target.new;
      created = true;
      if (fresh.ownerUserId && !(await isMember(tenant, fresh.ownerUserId))) throw new HttpError(400, 'Owner must be a household member.');
      account = {
        id: crypto.randomUUID(),
        householdId: tenant.householdId,
        source: 'manual',
        connectionId: null,
        externalId: null,
        name: fresh.name,
        plaidName: null,
        officialName: null,
        institutionName: fresh.institutionName ?? null,
        mask: fresh.mask ?? null,
        type: fresh.type,
        subtype: null,
        currency: fresh.currency,
        ownerUserId: fresh.ownerUserId ?? null,
        isHidden: false,
        category: null,
        balance: null,
        balanceAsOf: null,
        missingSince: null,
        sort: 0,
        holdingsVersion: entry.file.kind === 'holdings' ? 1 : 0,
        createdAt: now,
      };
    }
    if (entry.file.kind === 'holdings' && account.type !== 'investment') problem(entry.label, `holdings go in an investment account, and ${account.name} isn't one`);
    if (entry.file.currency && entry.file.currency !== account.currency) problem(entry.label, `the file is in ${entry.file.currency} but ${account.name} is in ${account.currency}`);
    targets.push({ entry, account, created });
  }
  // Accounts that can't take their files can't be planned.
  if (problems.length > 0) return { plans, shared, problems, today };

  // Securities: the household's, by ticker (adding market ones it doesn't have), or private ones for funds with no ticker.
  const holdingEntries = targets.filter((target): target is typeof target & { entry: { file: ImportedHoldings } } => target.entry.file.kind === 'holdings');
  const securityRows = await tenant.db
    .select({ id: securities.id, ticker: securities.ticker, type: securities.type, isPublic: securities.isPublic })
    .from(securities)
    .where(tenant.scope(securities));
  const cashTickers = new Set(securityRows.filter((row) => row.ticker && isCashSecurity(row)).map((row) => row.ticker!.toUpperCase()));
  const cashIds = new Set(securityRows.filter((row) => isCashSecurity(row)).map((row) => row.id));
  const privateIds = new Set(securityRows.filter((row) => !row.isPublic).map((row) => row.id));
  const byTicker = new Map<string, string>();
  const tickersByCurrency = new Map<string, string[]>();
  for (const { entry, account } of holdingEntries) {
    for (const security of entry.file.securities) {
      if (security.ticker && !cashTickers.has(security.ticker.toUpperCase())) (tickersByCurrency.get(account.currency) ?? tickersByCurrency.set(account.currency, []).get(account.currency)!).push(security.ticker);
    }
  }
  const fileNames = new Map(holdingEntries.flatMap(({ entry }) => entry.file.securities.flatMap((security) => (security.ticker ? [[security.ticker.toUpperCase(), security.name] as const] : []))));
  for (const [currency, tickers] of tickersByCurrency) {
    const found = await securitiesForTickers(deps, tenant, currency, tickers, fileNames);
    shared.push(...found.statements);
    for (const [ticker, id] of found.byTicker) byTicker.set(ticker, id);
  }
  for (const row of securityRows) if (row.ticker && !byTicker.has(row.ticker.toUpperCase())) byTicker.set(row.ticker.toUpperCase(), row.id);
  // Market prices for the market funds in the files, fetched once.
  const fileTickers = new Set(holdingEntries.flatMap(({ entry }) => entry.file.securities.flatMap((security) => (security.ticker ? [security.ticker.toUpperCase()] : []))));
  const marketTickers = [...fileTickers].filter((ticker) => byTicker.has(ticker) && !cashTickers.has(ticker) && !privateIds.has(byTicker.get(ticker)!));
  const earliest = holdingEntries.flatMap(({ entry }) => entry.file.transactions.map((txn) => txn.date)).sort()[0];
  let closes: (ticker: string, date: IsoDate) => number | null = () => null;
  let unfetched = new Set<string>();
  if (earliest && marketTickers.length > 0) {
    // Those it couldn't fetch (the provider down or rate-limited) are priced from the file instead, as estimates.
    unfetched = new Set((await ensureCloses(deps, marketTickers, earliest, today)).failed);
    closes = await closeLookup(deps, marketTickers, addDays(earliest, -PRICE_LOOKBACK_DAYS), today);
  }
  // Priced at each day's close: fetched, and known to the market data provider (else from the file, like a fund with no ticker).
  const hasCloses = new Set(marketTickers.filter((ticker) => !unfetched.has(ticker) && closes(ticker, today) !== null));

  for (const target of targets) {
    const { entry, account, created } = target;
    const base = { label: entry.label, account, created, statements: [] as BatchItem<'sqlite'>[], replacesHoldings: false, blocks: [] as BlockPayload[] };
    if (created) base.statements.push(tenant.db.insert(accounts).values(account));
    if (entry.file.kind === 'balances') {
      const dates = entry.file.rows.map((row) => row.date).sort();
      plans.push({ ...base, balances: entry.file.rows, days: dateRange(dates[0], dates.at(-1)!).length, from: dates[0], to: dates.at(-1)! });
      continue;
    }
    const plan = await planHoldings(deps, tenant, { ...base, file: entry.file, today, now, cashIds, byTicker, hasCloses, closes, problem: (text, date) => problem(entry.label, text, date) });
    if (plan) plans.push(plan);
  }
  return { plans, shared, problems, today };
}

function stop(problems: ImportProblem[]) {
  if (problems.length === 0) return;
  const listed = problems.slice(0, MAX_PROBLEMS).map((found) => `${found.label}: ${found.text}`).join('; ');
  throw new HttpError(409, `Nothing was imported: ${listed}${problems.length > MAX_PROBLEMS ? ` (and ${problems.length - MAX_PROBLEMS} more)` : ''}.`);
}

interface HoldingsContext {
  label: string;
  account: Account;
  created: boolean;
  statements: BatchItem<'sqlite'>[];
  replacesHoldings: boolean;
  blocks: BlockPayload[];
  file: ImportedHoldings;
  today: IsoDate;
  now: number;
  cashIds: Set<string>;
  byTicker: Map<string, string>;
  hasCloses: Set<string>;
  closes: (ticker: string, date: IsoDate) => number | null;
  problem: (text: string, date?: string) => void;
}

/** Check one account's holdings file and plan its writes; null (with problems noted) when it doesn't check out. */
async function planHoldings(deps: Deps, tenant: Tenant, context: HoldingsContext): Promise<Plan | null> {
  const { account, file, today, now, cashIds, byTicker, hasCloses, closes } = context;
  const manual = account.source === 'manual';
  let failed = false;
  const problem = (text: string, date?: string) => {
    failed = true;
    context.problem(text, date);
  };

  // Each of the file's securities as one of the household's.
  const fileSecurities = new Map(file.securities.map((security) => [security.id, security]));
  const securityOf = new Map<string, string>();
  const nameOf = new Map<string, string>();
  const filePriced = new Set<string>();
  const tickerOf = new Map<string, string>();
  for (const id of new Set([...file.positions.map((row) => row.security), ...file.transactions.flatMap((txn) => (txn.security ? [txn.security] : []))])) {
    const security = fileSecurities.get(id);
    const ticker = security?.ticker?.toUpperCase();
    const known = ticker ? byTicker.get(ticker) : undefined;
    if (known) {
      securityOf.set(id, known);
      tickerOf.set(known, ticker!);
      if (!cashIds.has(known) && !hasCloses.has(ticker!)) filePriced.add(known);
    } else {
      // No market ticker: the file's id for it (a CUSIP) stands in.
      const securityId = await stableId(`security:import:${tenant.householdId}:${id}`);
      const name = security?.name ?? id;
      const suggestion = suggestClassification({ ticker: id, name, type: 'mutual fund', currency: account.currency });
      context.statements.push(
        tenant.db
          .insert(securities)
          .values({
            id: securityId,
            householdId: tenant.householdId,
            ticker: id,
            name,
            type: 'mutual fund',
            currency: account.currency,
            isPublic: false,
            classification: suggestion.classification,
            classificationSource: suggestion.source,
            needsReview: suggestion.needsReview,
            createdAt: now,
          })
          // Keep a classification you've set; follow the file's name.
          .onConflictDoUpdate({ target: securities.id, set: { name } }),
      );
      securityOf.set(id, securityId);
      filePriced.add(securityId);
    }
    nameOf.set(securityOf.get(id)!, security?.name ?? id);
  }
  const describe = (securityId: string) => tickerOf.get(securityId) ?? nameOf.get(securityId) ?? 'a holding';
  // Market funds without closes for now: re-importing once they can be fetched prices them at each day's close.
  const estimated = [...filePriced].flatMap((id) => (tickerOf.has(id) ? [tickerOf.get(id)!] : [])).sort();
  const isCash = (securityId: string | null) => securityId === null || cashIds.has(securityId);

  // The account's cash: the cash security it holds (a settlement fund, or Plaid's CUR:USD), else one for its currency.
  const held = context.created
    ? []
    : await tenant.db
        .select({ securityId: holdings.securityId, type: securities.type, ticker: securities.ticker })
        .from(holdings)
        .innerJoin(securities, eq(securities.id, holdings.securityId))
        .where(tenant.scope(holdings, eq(holdings.accountId, account.id)));
  let cashSecurityId = held.find((row) => isCashSecurity(row))?.securityId ?? file.positions.map((row) => securityOf.get(row.security)!).find((id) => cashIds.has(id));
  if (!cashSecurityId) {
    cashSecurityId = await stableId(`security:manual:${tenant.householdId}:CUR:${account.currency}`);
    context.statements.push(
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
          createdAt: now,
        })
        .onConflictDoNothing(),
    );
  }

  // Positions and transactions as the walk back takes them: shares per security, cash in cents (positive out).
  const positions = file.positions.map((row) => ({ ...row, securityId: securityOf.get(row.security)! }));
  const cashUnits = file.cash / 100 + positions.filter((row) => isCash(row.securityId)).reduce((sum, row) => sum + row.shares, 0);
  const holdingsNow: BackfillHolding[] = [...positions.filter((row) => !isCash(row.securityId)).map((row) => ({ securityId: row.securityId, quantity: row.shares })), { securityId: cashSecurityId, quantity: cashUnits }];
  // An account holding no cash and moving none (a 401(k)): contributions and fees buy and sell its funds directly.
  const cashless = cashUnits === 0 && !file.transactions.some((txn) => CASH_KINDS.has(txn.kind) || (txn.security && isCash(securityOf.get(txn.security)!)));
  const transactions: BackfillTransaction[] = file.transactions.flatMap((txn) => {
    const securityId = txn.security ? securityOf.get(txn.security)! : null;
    const cash = isCash(securityId);
    const quantity = !cash && SHARE_KINDS.has(txn.kind) ? txn.shares : 0;
    // Between the account's cash and a money market fund, or a sweep: both cash, so cash doesn't change.
    const cashIn = cashless || txn.kind === 'sweep' || (cash && SHARE_KINDS.has(txn.kind)) ? 0 : txn.kind === 'fee' ? -Math.abs(txn.amount) : txn.amount;
    if (quantity === 0 && cashIn === 0) return [];
    return [{ date: txn.date, securityId: cash ? null : securityId, quantity, amount: -cashIn }];
  });

  // Walking back from the positions, no fund can have held fewer than none.
  const quantities = new Map(holdingsNow.map((row) => [row.securityId, row.quantity]));
  const short = new Set<string>();
  for (const txn of [...transactions].sort((a, b) => b.date.localeCompare(a.date))) {
    if (!txn.securityId || txn.quantity === 0) continue;
    const earlier = (quantities.get(txn.securityId) ?? 0) - txn.quantity;
    quantities.set(txn.securityId, earlier);
    if (earlier < -SHARES_EPSILON && !short.has(txn.securityId)) {
      short.add(txn.securityId);
      problem(`before ${txn.date}, ${describe(txn.securityId)} would have ${earlier.toFixed(4)} shares`, txn.date);
    }
  }
  // Each trade's close, for the preview.
  const tradeCloses: NonNullable<Plan['closes']> = [];
  for (const txn of file.transactions) {
    const securityId = txn.security ? securityOf.get(txn.security)! : null;
    if (!securityId || isCash(securityId) || txn.price <= 0) continue;
    // Priced from the file: each total must be its shares × price.
    if (filePriced.has(securityId) && PRICED_KINDS.has(txn.kind) && txn.value > 0) {
      const worth = Math.round(Math.abs(txn.shares) * txn.price * 100);
      if (Math.abs(txn.value - worth) > txn.charges + 1 + Math.ceil(SHARE_ROUNDING * txn.price * 100)) problem(`on ${txn.date}, ${describe(securityId)} shows ${txn.value / 100} for ${Math.abs(txn.shares)} shares at ${txn.price}`, txn.date);
    }
    // A market fund: each buy or sell near that day's close.
    const ticker = tickerOf.get(securityId);
    const close = ticker && hasCloses.has(ticker) && PRICED_KINDS.has(txn.kind) ? closes(ticker, txn.date) : null;
    if (close) tradeCloses.push({ date: txn.date, security: txn.security!, close });
    if (close && TRADES.has(txn.kind) && Math.abs(txn.price - close) / close > PRICE_TOLERANCE) problem(`on ${txn.date}, ${ticker} traded at ${txn.price} but closed at ${close}`, txn.date);
  }

  // Which days are written: a linked account's up to its first synced day, a manual account's through today.
  const start = file.transactions.map((txn) => txn.date).sort()[0];
  let end = today;
  if (!manual) {
    const [first] = await tenant.db
      .select({ date: min(accountDaily.date) })
      .from(accountDaily)
      .where(tenant.scope(accountDaily, eq(accountDaily.accountId, account.id), eq(accountDaily.source, 'snapshot')));
    const firstSynced = first?.date ?? null;
    end = firstSynced ? addDays(firstSynced, -1) : addDays(today, -1);
    if (end < start) problem('the file has no days before Wattle started syncing this account');
    // Since the link: the walk reaches the share counts actually synced.
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
          if (Math.abs(fromFile - fromSync) > SHARES_EPSILON) problem(`on ${day.date}, ${id === cashSecurityId ? 'cash' : describe(id)} is ${fromFile} in the file but ${fromSync} synced`, day.date);
        }
      }
    }
  }
  if (failed) return null;

  // The institution's prices by day, for funds priced from the file: each trade's, and the positions' on the day they're as of.
  const prices: Record<string, [IsoDate, number][]> = {};
  const addPrice = (securityId: string, date: IsoDate, price: number | undefined) => {
    if (!filePriced.has(securityId) || !price || price <= 0) return;
    const points = (prices[securityId] ??= []);
    if (!points.some(([day]) => day === date)) points.push([date, price]);
  };
  for (const txn of file.transactions) if (txn.security) addPrice(securityOf.get(txn.security)!, txn.date, txn.price);
  for (const row of positions) addPrice(row.securityId, file.asOf, row.price);
  for (const points of Object.values(prices)) points.sort((a, b) => a[0].localeCompare(b[0]));

  if (manual) {
    // The positions are the account's holdings now; a fund without market prices carries the file's last price.
    for (const row of positions) {
      if (row.price !== undefined && filePriced.has(row.securityId) && !tickerOf.has(row.securityId)) {
        context.statements.push(tenant.db.update(securities).set({ lastPrice: row.price, lastPriceDate: file.asOf }).where(tenant.scope(securities, eq(securities.id, row.securityId))));
      }
    }
    const holdingRows = [
      ...positions.filter((row) => !isCash(row.securityId)).map((row) => ({ securityId: row.securityId, quantity: row.shares, price: row.price ?? null })),
      ...(cashUnits !== 0 ? [{ securityId: cashSecurityId, quantity: cashUnits, price: 1 }] : []),
    ];
    if (!context.created) context.statements.push(tenant.db.delete(holdings).where(tenant.scope(holdings, eq(holdings.accountId, account.id))));
    // Nothing held now (a closed account): its balance is nothing, not unknown, as the snapshot only counts holdings it has.
    if (holdingRows.length === 0) context.statements.push(tenant.db.update(accounts).set({ balance: 0, balanceAsOf: now }).where(tenant.scope(accounts, eq(accounts.id, account.id))));
    context.statements.push(
      ...chunkRows(
        holdings,
        holdingRows.map((row) => ({
          householdId: tenant.householdId,
          accountId: account.id,
          securityId: row.securityId,
          quantity: row.quantity,
          price: row.price,
          priceAsOf: row.price === null ? null : file.asOf,
          value: row.price === null ? 0 : Math.round(row.quantity * row.price * 100),
          currency: account.currency,
          updatedAt: now,
        })),
      ).map((chunk) => tenant.db.insert(holdings).values(chunk)),
    );
  }

  const size = daysPerBlock(deps, holdingsNow.length);
  const blocks = windows(start, end, size).map(([from, to]): BlockPayload => ({
    accountId: account.id,
    start,
    end: today,
    from,
    to,
    holdings: holdingsNow,
    transactions,
    cashSecurityId: cashSecurityId!,
    ...(Object.keys(prices).length > 0 ? { prices } : {}),
    ...(manual ? { replaceSnapshots: true } : {}),
  }));
  return {
    label: context.label,
    account,
    created: context.created,
    statements: context.statements,
    replacesHoldings: manual && !context.created,
    blocks,
    days: dateRange(start, end).length,
    from: start,
    to: end,
    estimated,
    closes: tradeCloses,
  };
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
      const points = block.prices?.[securityId];
      if (points) return fundPrice(points, date);
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
        .where(tenant.scope(holdingDaily, eq(holdingDaily.accountId, account.id), gte(holdingDaily.date, block.from), lte(holdingDaily.date, block.to), inArray(holdingDaily.source, block.replaceSnapshots ? ['rebuilt', 'carried', 'import', 'snapshot'] : ['rebuilt', 'carried', 'import']))),
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

/**
 * Queue repricing for accounts with imported days of market funds priced from
 * the file (their closes couldn't be fetched when imported): nightly, once a
 * day per account, until they're all at a close.
 */
export async function queueImportRepricing(deps: Deps, tenant: Tenant): Promise<number> {
  const accountIds = [...new Set((await importedEstimates(tenant)).map((row) => row.accountId))];
  const today = marketDate(deps.now());
  await enqueue(
    deps,
    tenant,
    accountIds.map((accountId) => ({ id: `import-reprice:${accountId}:${today}`, type: 'import_reprice' as const, payload: { accountId } })),
  );
  return accountIds.length;
}

/**
 * import_reprice: an account's imported estimates at each day's close. First
 * (no window) the closes are fetched, one request per ticker for the days
 * missing (those still failing stay estimates for another night); then one
 * job per window of days reprices them, moving each day's balance by the
 * difference.
 */
export async function importReprice({ deps, tenant, job, renew }: JobContext): Promise<Record<string, unknown>> {
  const { accountId, from, to } = job.payload as { accountId: string; from?: IsoDate; to?: IsoDate };
  const [account] = await tenant.db.select().from(accounts).where(tenant.scope(accounts, eq(accounts.id, accountId)));
  if (!account || account.isHidden) return { rows: 0 };
  if (!from || !to) {
    const rows = await importedEstimates(tenant, { accountId });
    if (rows.length === 0) return { rows: 0 };
    const tickers = [...new Set(rows.map((row) => row.ticker))];
    const dates = rows.map((row) => row.date).sort();
    const gaps = await ensureCloses(deps, tickers, dates[0], dates.at(-1)!);
    const size = daysPerBlock(deps, tickers.length);
    await enqueue(
      deps,
      tenant,
      windows(dates[0], dates.at(-1)!, size).map(([blockFrom, blockTo]) => ({ id: `${job.id}:${blockFrom}`, type: 'import_reprice' as const, payload: { accountId, from: blockFrom, to: blockTo }, connectionId: account.connectionId })),
    );
    return { rows: rows.length, tickers: tickers.length, unfetched: gaps.failed.length };
  }
  const rows = await importedEstimates(tenant, { accountId, from, before: addDays(to, 1) });
  if (rows.length === 0) return { rows: 0 };
  const dated = await datedCloseLookup(deps, [...new Set(rows.map((row) => row.ticker))], addDays(from, -PRICE_LOOKBACK_DAYS), to);
  const statements = repriced(tenant, rows, dated, ['import']);
  if (statements.length === 0) return { rows: 0 };
  const lease = await Lease.acquireWaiting(deps, tenant, account.connectionId ? connectionLease(account.connectionId) : accountLease(account.id));
  if (!lease) throw new RetryLater(BUSY_RETRY_SECONDS, 'The account is busy.');
  try {
    await renew();
    await lease.renew();
    await runAtomic(tenant.db, statements);
  } finally {
    await lease.forceRelease();
  }
  return { rows: rows.length };
}

/** A security's name as compared across institutions: letters and digits only ("Example Corp, Inc." is "examplecorpinc"). */
const nameKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
/** Searches made at most per request, so a long list doesn't spend the market data provider's allowance. */
const MAX_SEARCHES = 25;


/**
 * Tickers for securities a file names without one (some institutions give a
 * security no longer held only its CUSIP): a security of yours with the same
 * name first, else the market data provider's search by name, taking a US
 * listing whose name is the file's or starts the same (the shortest ticker
 * of several). Funds with no market
 * price (a plan's trusts) get none.
 */
export async function suggestTickers(deps: Deps, tenant: Tenant, wanted: { id: string; name: string }[]): Promise<TickerSuggestion[]> {
  const rows = await tenant.db.select({ ticker: securities.ticker, name: securities.name, type: securities.type, isPublic: securities.isPublic }).from(securities).where(tenant.scope(securities));
  const yours = new Map(rows.filter((row) => row.isPublic && row.ticker && row.name && !isCashSecurity(row)).map((row) => [nameKey(row.name!), row.ticker!.toUpperCase()]));
  const suggestions: TickerSuggestion[] = [];
  let searches = 0;
  for (const { id, name } of wanted) {
    const key = nameKey(name);
    const own = yours.get(key);
    if (own) {
      suggestions.push({ id, ticker: own, from: 'yours' });
      continue;
    }
    if (!deps.prices?.search || key.length < 4) continue;
    // The whole name, then its first three words (a search can miss "Example Group Ltd Sponsored ADR" but find "Example Group Ltd").
    const queries = [name, name.split(/\s+/).slice(0, 3).join(' ')].filter((query, index, all) => all.indexOf(query) === index);
    let match: { ticker: string; name: string } | undefined;
    for (const query of queries) {
      if (match || searches >= MAX_SEARCHES) break;
      searches += 1;
      let found: { ticker: string; name: string }[];
      try {
        found = await deps.prices.search(query);
      } catch (error) {
        // Rate-limited or down: no more searches this time; the rest are typed by hand.
        console.warn('Ticker search failed', describeError(error));
        searches = MAX_SEARCHES;
        break;
      }
      const named = found.filter((listing) => {
        const listed = nameKey(listing.name);
        return listed === key || (Math.min(listed.length, key.length) >= 6 && (listed.startsWith(key) || key.startsWith(listed)));
      });
      // Several listings under one name (a when-issued XYZV beside XYZ): the exact name, then the shortest ticker.
      match = named.sort((a, b) => Number(nameKey(b.name) === key) - Number(nameKey(a.name) === key) || a.ticker.length - b.ticker.length)[0];
    }
    if (match) suggestions.push({ id, ticker: match.ticker, from: 'search' });
  }
  return suggestions;
}

/** Imports still being written, by account: how many of their windows of days are done. */
export async function importProgress(tenant: Tenant): Promise<Map<string, { done: number; total: number }>> {
  const underway = await tenant.db
    .selectDistinct({ groupId: jobs.groupId })
    .from(jobs)
    .where(tenant.scope(jobs, eq(jobs.type, 'import_block'), inArray(jobs.status, ['waiting', 'queued', 'running'])));
  const groups = underway.flatMap((row) => (row.groupId ? [row.groupId] : []));
  const progress = new Map<string, { done: number; total: number }>();
  if (groups.length === 0) return progress;
  const parts = await tenant.db
    .select({ payload: jobs.payload, status: jobs.status })
    .from(jobs)
    .where(tenant.scope(jobs, eq(jobs.type, 'import_block'), inArray(jobs.groupId, groups)));
  for (const part of parts) {
    const accountId = (part.payload as { accountId?: string }).accountId;
    if (!accountId) continue;
    const entry = progress.get(accountId) ?? { done: 0, total: 0 };
    entry.total += 1;
    if (part.status === 'done' || part.status === 'failed') entry.done += 1;
    progress.set(accountId, entry);
  }
  return progress;
}
