/**
 * Daily snapshots: one account_daily row per visible account and one
 * holding_daily row per holding, valued at the day's close. Idempotent —
 * rerunning a day overwrites that day's synced rows. A linked account's
 * balance reported that day replaces anything entered or imported for it (the
 * institution's figure is the real one); otherwise entered and imported values
 * are never overwritten. A balance carried forward (the sync failed, or the
 * login is disconnected) is marked estimated, so a later bank-history report
 * can replace it.
 *
 * One snapshot per household at a time (its lease), written atomically. A
 * change that finds a snapshot running leaves a note, and the running one goes
 * again: every change is followed by a snapshot that read it, so the last
 * snapshot written always reflects the latest data.
 *
 * Each snapshot is logged in snapshot_runs, written 'running' as it starts;
 * the next snapshot to take the lease marks one left running as interrupted.
 */
import { eq, inArray, sql } from 'drizzle-orm';
import { marketDate, type IsoDate } from '../../shared/dates';
import { chunkRows, runAtomic } from '../db/batch';
import { accountDaily, accounts, holdingDaily, holdings, securities, snapshotRuns } from '../db/schema';
import { describeError } from '../lib/errors';
import { INTERRUPTED, INTERRUPTED_MESSAGE } from './activity';
import type { Tenant } from '../db/tenant';
import type { Deps } from '../ports';
import { holdWhile, Lease, snapshotLease } from './lease';
import { closeLookup, ensureRecentCloses } from './pricing';
import { priceOn } from './valuation';

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
      ticker: securities.ticker,
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
  const closes = await closeLookup(deps, publicTickers, date, date);

  const visible = new Set(accountRows.map((account) => account.id));
  const holdingDailyRows: (typeof holdingDaily.$inferInsert)[] = [];
  const totals = new Map<string, number>();
  for (const row of holdingRows) {
    if (!visible.has(row.accountId)) continue;
    const priced = priceOn({ ...row, lastPrice: row.lastPrice ?? row.price }, date, closes);
    const price = priced?.price ?? row.price ?? 0;
    const value = Math.round(row.quantity * price * 100);
    totals.set(row.accountId, (totals.get(row.accountId) ?? 0) + value);
    holdingDailyRows.push({
      householdId: tenant.householdId,
      accountId: row.accountId,
      securityId: row.securityId,
      date,
      quantity: row.quantity,
      price,
      value,
      currency: row.currency,
      source: 'sync',
      estimated: priced?.estimated ?? true,
    });
  }

  // Snapshot rows are always `sync`; `manual` is reserved for values a person
  // entered. Reported: a linked account synced that day, whose figure wins.
  const reportedRows: (typeof accountDaily.$inferInsert)[] = [];
  const otherRows: (typeof accountDaily.$inferInsert)[] = [];
  for (const account of accountRows) {
    const balance = totals.get(account.id) ?? account.balance;
    if (balance === null) continue;
    const reported = account.source === 'plaid' && account.balanceAsOf !== null && marketDate(new Date(account.balanceAsOf)) >= date;
    // Linked (or disconnected) accounts not synced that day carry their last balance forward.
    const estimated = !reported && account.connectionId !== null;
    (reported ? reportedRows : otherRows).push({
      householdId: tenant.householdId,
      accountId: account.id,
      date,
      balance,
      currency: account.currency,
      source: 'sync',
      estimated,
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
    lease.clearNotesBefore(startedAt),
    // Replace the day's synced positions so a sale made today drops out.
    // Imported rows are left alone.
    ...(visible.size > 0
      ? [
          tenant.db
            .delete(holdingDaily)
            .where(
              tenant.scope(
                holdingDaily,
                eq(holdingDaily.date, date),
                inArray(holdingDaily.accountId, [...visible]),
                inArray(holdingDaily.source, ['sync', 'backfill']),
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
          set: {
            quantity: sql`excluded.quantity`,
            price: sql`excluded.price`,
            value: sql`excluded.value`,
            source: sql`excluded.source`,
            estimated: sql`excluded.estimated`,
          },
          setWhere: sql`${holdingDaily.source} in ('sync', 'backfill')`,
        }),
    ),
    ...chunkRows(accountDaily, reportedRows).map((chunk) =>
      tenant.db
        .insert(accountDaily)
        .values(chunk)
        .onConflictDoUpdate({
          target: [accountDaily.accountId, accountDaily.date],
          set: { balance: sql`excluded.balance`, source: sql`excluded.source`, estimated: sql`0` },
        }),
    ),
    ...chunkRows(accountDaily, otherRows).map((chunk) =>
      tenant.db
        .insert(accountDaily)
        .values(chunk)
        .onConflictDoUpdate({
          target: [accountDaily.accountId, accountDaily.date],
          set: { balance: sql`excluded.balance`, source: sql`excluded.source`, estimated: sql`excluded.estimated` },
          setWhere: sql`${accountDaily.source} in ('sync', 'backfill')`,
        }),
    ),
  ]);

  return { accounts: reportedRows.length + otherRows.length, holdings: holdingDailyRows.length };
}
