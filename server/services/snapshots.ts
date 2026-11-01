/**
 * Daily snapshots: one account_daily row per visible account and one
 * holding_daily row per holding, valued at the day's close. Idempotent —
 * rerunning a day overwrites that day's synced rows. Entered and imported
 * values are never overwritten (shared/quality.ts: they're trusted most). A
 * linked account not synced that day (the sync failed, or the login is
 * disconnected) has its last balance and holdings carried forward, marked
 * `carried`, so a later rebuild or bank-history report can replace them.
 *
 * One snapshot per household at a time (its lease), written atomically. A
 * change that finds a snapshot running leaves a note, and the running one goes
 * again: every change is followed by a snapshot that read it, so the last
 * snapshot written always reflects the latest data.
 *
 * Each snapshot is logged in snapshot_runs, written 'running' as it starts;
 * the next snapshot to take the lease marks one left running as interrupted.
 *
 * Public holdings are valued at a close dated for the day (the last trading
 * day's, on a weekend): Tiingo's, Plaid's own close_price (dated by
 * close_price_as_of), or the institution's price when its time
 * (institution_price_datetime) falls between that close and the next open.
 * A price is never assigned to a day by when it was fetched. Until a day's
 * dated close exists (mutual fund NAVs often reach Tiingo the next morning)
 * the holding carries its last dated close and is provisional
 * (price_source 'provisional'); each snapshot reprices the past week's
 * provisional rows once a dated close for their day exists, correcting
 * their accounts' balances by the difference. A final row isn't rewritten.
 */
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { addDays, closeDayOf, lastTradingDay, marketDate, type IsoDate } from '../../shared/dates';
import { chunkRows, runAtomic } from '../db/batch';
import { accountDaily, accounts, holdingDaily, holdings, securities, snapshotRuns } from '../db/schema';
import { describeError } from '../lib/errors';
import { INTERRUPTED, INTERRUPTED_MESSAGE } from './activity';
import type { Tenant } from '../db/tenant';
import type { BatchItem } from 'drizzle-orm/batch';
import type { Deps } from '../ports';
import { holdWhile, Lease, snapshotLease } from './lease';
import { datedCloseLookup, ensureRecentCloses, type DatedCloseLookup } from './pricing';
import { priceOn } from './valuation';
import { QUALITY_SET, replaceWhere } from './quality';
import { leastFinal, type PriceSource } from '../../shared/quality';

/** How far back a snapshot looks for provisional prices to correct. */
export const REPRICE_DAYS = 7;

export async function snapshotHousehold(
  deps: Deps,
  tenant: Tenant,
  date: IsoDate,
  trigger: 'nightly' | 'change' = 'change',
): Promise<{ accounts: number; holdings: number; skipped?: boolean }> {
  const key = snapshotLease(tenant.householdId);
  let lease = await Lease.acquire(deps, tenant, key);
  if (!lease) {
    await Lease.leaveNote(deps, tenant, key);
    // The holder may have released just before the note: then run it ourselves.
    lease = await Lease.acquire(deps, tenant, key);
    if (!lease) return { accounts: 0, holdings: 0, skipped: true };
  }
  const held = lease;
  const id = crypto.randomUUID();
  const startedAt = deps.now().getTime();
  const logged = (values: Partial<typeof snapshotRuns.$inferInsert>) =>
    tenant.db.update(snapshotRuns).set({ finishedAt: deps.now().getTime(), ...values }).where(tenant.scope(snapshotRuns, eq(snapshotRuns.id, id)));
  await runAtomic(tenant.db, [
    // Holding the lease, no other snapshot is running: one marked running was stopped part-way.
    tenant.db
      .update(snapshotRuns)
      .set({ outcome: 'error', errorCode: INTERRUPTED, errorMessage: INTERRUPTED_MESSAGE, finishedAt: startedAt })
      .where(tenant.scope(snapshotRuns, eq(snapshotRuns.outcome, 'running'))),
    tenant.db
      .insert(snapshotRuns)
      .values({ id, householdId: tenant.householdId, date, trigger, startedAt, finishedAt: startedAt, outcome: 'running' }),
  ]);
  let result = { accounts: 0, holdings: 0 };
  try {
    await holdWhile(held, async () => {
      result = await snapshotOnce(deps, tenant, date, held);
    });
  } catch (error) {
    await logged({ outcome: 'error', errorMessage: describeError(error).slice(0, 500) }).catch(() => {});
    throw error;
  }
  await logged({ outcome: 'ok', accounts: result.accounts, holdings: result.holdings });
  return result;
}

async function snapshotOnce(deps: Deps, tenant: Tenant, date: IsoDate, lease: Lease): Promise<{ accounts: number; holdings: number }> {
  const startedAt = deps.now().getTime();
  const accountRows = await tenant.db
    .select()
    .from(accounts)
    .where(tenant.scope(accounts, eq(accounts.isHidden, false)));

  const holdingRows = await tenant.db
    .select({
      accountId: holdings.accountId,
      securityId: holdings.securityId,
      quantity: holdings.quantity,
      price: holdings.price,
      currency: holdings.currency,
      priceAt: holdings.priceAt,
      ticker: securities.ticker,
      plaidClose: securities.plaidClose,
      plaidCloseDate: securities.plaidCloseDate,
      type: securities.type,
      isPublic: securities.isPublic,
      lastPrice: securities.lastPrice,
      lastPriceDate: securities.lastPriceDate,
    })
    .from(holdings)
    .innerJoin(securities, eq(securities.id, holdings.securityId))
    .where(tenant.scope(holdings));

  const publicTickers = holdingRows.filter((row) => row.isPublic && row.ticker).map((row) => row.ticker!);
  await ensureRecentCloses(deps, publicTickers, date);
  const repriceFrom = addDays(date, -REPRICE_DAYS);
  const provisional = await provisionalRows(tenant, repriceFrom, date);
  const dated = await datedCloseLookup(deps, [...publicTickers, ...provisional.map((row) => row.ticker)], repriceFrom, date);
  const closes = (ticker: string, day: IsoDate) => dated(ticker, day)?.close ?? null;

  const visible = new Set(accountRows.map((account) => account.id));
  // Linked (or disconnected) accounts not synced that day carry their last balance and holdings forward.
  const carried = new Set(
    accountRows
      .filter((account) => account.connectionId !== null && !(account.source === 'plaid' && account.balanceAsOf !== null && marketDate(new Date(account.balanceAsOf)) >= date))
      .map((account) => account.id),
  );
  const holdingDailyRows: (typeof holdingDaily.$inferInsert)[] = [];
  const totals = new Map<string, number>();
  const prices = new Map<string, (PriceSource | null)[]>();
  for (const row of holdingRows) {
    if (!visible.has(row.accountId)) continue;
    const priced = dayClose(row, date, dated) ?? priceOn({ ...row, lastPrice: row.lastPrice ?? row.price }, date, closes);
    const price = priced?.price ?? row.price ?? 0;
    const priceSource = priced?.source ?? 'institution';
    const value = Math.round(row.quantity * price * 100);
    totals.set(row.accountId, (totals.get(row.accountId) ?? 0) + value);
    prices.set(row.accountId, [...(prices.get(row.accountId) ?? []), priceSource]);
    holdingDailyRows.push({
      householdId: tenant.householdId,
      accountId: row.accountId,
      securityId: row.securityId,
      date,
      quantity: row.quantity,
      price,
      value,
      currency: row.currency,
      source: carried.has(row.accountId) ? 'carried' : 'snapshot',
      priceSource,
      unmatched: false,
    });
  }

  // A balance from holdings or a synced one is a snapshot; a manual
  // account's balance without holdings is its last entry, carried.
  const accountDailyRows: (typeof accountDaily.$inferInsert)[] = [];
  for (const account of accountRows) {
    const fromHoldings = totals.get(account.id);
    const balance = fromHoldings ?? account.balance;
    if (balance === null) continue;
    const source = carried.has(account.id) || (account.connectionId === null && fromHoldings === undefined) ? 'carried' : 'snapshot';
    accountDailyRows.push({
      householdId: tenant.householdId,
      accountId: account.id,
      date,
      balance,
      currency: account.currency,
      source,
      priceSource: leastFinal(prices.get(account.id) ?? []),
      unmatched: false,
    });
  }

  // Manual accounts tracked by holdings take their balance from them.
  const balanceUpdates = accountRows.flatMap((account) => {
    const fromHoldings = totals.get(account.id);
    return account.source === 'manual' && fromHoldings !== undefined && fromHoldings !== account.balance
      ? [tenant.db.update(accounts).set({ balance: fromHoldings, balanceAsOf: deps.now().getTime() }).where(tenant.scope(accounts, eq(accounts.id, account.id)))]
      : [];
  });

  await lease.renew();
  await runAtomic(tenant.db, [
    ...balanceUpdates,
    ...repriced(tenant, provisional.filter((row) => visible.has(row.accountId)), dated),
    lease.clearNotesBefore(startedAt),
    // Replace the day's synced positions so a sale made today drops out.
    // Imported and entered rows are left alone.
    ...(visible.size > 0
      ? [
          tenant.db
            .delete(holdingDaily)
            .where(
              tenant.scope(
                holdingDaily,
                eq(holdingDaily.date, date),
                inArray(holdingDaily.accountId, [...visible]),
                inArray(holdingDaily.source, ['snapshot', 'rebuilt', 'carried']),
              ),
            ),
        ]
      : []),
    ...chunkRows(holdingDaily, holdingDailyRows).map((chunk) =>
      tenant.db
        .insert(holdingDaily)
        .values(chunk)
        .onConflictDoUpdate({
          target: [holdingDaily.accountId, holdingDaily.securityId, holdingDaily.date],
          set: { quantity: sql`excluded.quantity`, price: sql`excluded.price`, value: sql`excluded.value`, ...QUALITY_SET },
          setWhere: replaceWhere(holdingDaily.source),
        }),
    ),
    ...chunkRows(accountDaily, accountDailyRows).map((chunk) =>
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

  return { accounts: accountDailyRows.length, holdings: holdingDailyRows.length };
}

interface DatedPrices {
  ticker: string | null;
  isPublic: boolean;
  /** Plaid's close for the security, and its day. */
  plaidClose: number | null;
  plaidCloseDate: string | null;
  /** The institution's price for the holding, and when it was current. */
  price: number | null;
  priceAt: number | null;
}

/** The latest close dated on or before `date` among Tiingo's, Plaid's and the institution's (Tiingo's on a tie). */
function latestDatedClose(row: DatedPrices, date: IsoDate, dated: DatedCloseLookup): { date: IsoDate; close: number } | null {
  const candidates: { date: IsoDate; close: number }[] = [];
  const tiingo = row.ticker ? dated(row.ticker, date) : null;
  if (tiingo) candidates.push(tiingo);
  // A Plaid close dated on a weekend isn't a close.
  if (row.plaidClose !== null && row.plaidCloseDate && row.plaidCloseDate <= date && lastTradingDay(row.plaidCloseDate) === row.plaidCloseDate) candidates.push({ date: row.plaidCloseDate, close: row.plaidClose });
  const institutionDay = row.priceAt !== null ? closeDayOf(row.priceAt) : null;
  if (row.price !== null && institutionDay && institutionDay <= date) candidates.push({ date: institutionDay, close: row.price });
  return candidates.reduce<{ date: IsoDate; close: number } | null>((best, candidate) => (!best || candidate.date > best.date ? candidate : best), null);
}

/**
 * A public holding's price for the day: final at a close dated for it,
 * otherwise provisional at the latest dated close before it. Null for a
 * holding without a public ticker or any dated close (priceOn decides).
 */
function dayClose(row: DatedPrices, date: IsoDate, dated: DatedCloseLookup): { price: number; source: 'close' | 'provisional' } | null {
  if (!row.isPublic || !row.ticker) return null;
  const close = latestDatedClose(row, date, dated);
  return close ? { price: close.close, source: close.date < lastTradingDay(date) ? 'provisional' : 'close' } : null;
}

/** Public holdings' rows in [from, before) not yet at a close for their day (provisional, or the institution's price), with their dated prices from Plaid. */
async function provisionalRows(tenant: Tenant, from: IsoDate, before: IsoDate) {
  const rows = await tenant.db
    .select({
      accountId: holdingDaily.accountId,
      securityId: holdingDaily.securityId,
      date: holdingDaily.date,
      quantity: holdingDaily.quantity,
      value: holdingDaily.value,
      ticker: securities.ticker,
      isPublic: securities.isPublic,
      plaidClose: securities.plaidClose,
      plaidCloseDate: securities.plaidCloseDate,
      price: holdings.price,
      priceAt: holdings.priceAt,
    })
    .from(holdingDaily)
    .innerJoin(securities, eq(securities.id, holdingDaily.securityId))
    .leftJoin(holdings, and(eq(holdings.accountId, holdingDaily.accountId), eq(holdings.securityId, holdingDaily.securityId)))
    .where(
      tenant.scope(
        holdingDaily,
        inArray(holdingDaily.priceSource, ['provisional', 'institution']),
        inArray(holdingDaily.source, ['snapshot', 'rebuilt', 'carried']),
        gte(holdingDaily.date, from),
        lt(holdingDaily.date, before),
        eq(securities.isPublic, true),
      ),
    );
  return rows.filter((row): row is typeof row & { ticker: string } => row.ticker !== null);
}

/** The least final price source among an account's holdings that day (shared/quality.ts leastFinal, in SQL). */
function leastFinalSql(accountId: string, date: IsoDate) {
  const priced = (source: string) => sql`sum(${holdingDaily.priceSource} = ${source}) > 0`;
  return sql`(select case when ${priced('provisional')} then 'provisional' when ${priced('interpolated')} then 'interpolated' when ${priced('institution')} then 'institution' when count(${holdingDaily.priceSource}) > 0 then 'close' end from ${holdingDaily} where ${holdingDaily.accountId} = ${accountId} and ${holdingDaily.date} = ${date})`;
}

/**
 * Statements repricing provisional rows that now have a close dated for
 * their day, and moving their accounts' synced balances for those days by
 * the difference.
 */
function repriced(tenant: Tenant, rows: Awaited<ReturnType<typeof provisionalRows>>, dated: DatedCloseLookup): BatchItem<'sqlite'>[] {
  const statements: BatchItem<'sqlite'>[] = [];
  const deltas = new Map<string, { accountId: string; date: IsoDate; delta: number }>();
  for (const row of rows) {
    const priced = dayClose(row, row.date, dated);
    if (!priced || priced.source !== 'close') continue;
    const value = Math.round(row.quantity * priced.price * 100);
    statements.push(
      tenant.db
        .update(holdingDaily)
        .set({ price: priced.price, value, priceSource: 'close' })
        .where(tenant.scope(holdingDaily, eq(holdingDaily.accountId, row.accountId), eq(holdingDaily.securityId, row.securityId), eq(holdingDaily.date, row.date))),
    );
    const key = `${row.accountId}|${row.date}`;
    const entry = deltas.get(key) ?? { accountId: row.accountId, date: row.date, delta: 0 };
    entry.delta += value - row.value;
    deltas.set(key, entry);
  }
  for (const { accountId, date, delta } of deltas.values()) {
    // The balance moves by the difference, and its price source is its holdings' least final again.
    statements.push(
      tenant.db
        .update(accountDaily)
        .set({ balance: sql`${accountDaily.balance} + ${delta}`, priceSource: leastFinalSql(accountId, date) })
        .where(
          tenant.scope(
            accountDaily,
            eq(accountDaily.accountId, accountId),
            eq(accountDaily.date, date),
            inArray(accountDaily.source, ['snapshot', 'rebuilt', 'carried']),
          ),
        ),
    );
  }
  return statements;
}
