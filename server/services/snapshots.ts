/**
 * Daily snapshots: one account_daily row per visible account and one
 * holding_daily row per holding, valued at the day's close. Idempotent —
 * rerunning a day overwrites that day's synced rows. Manually entered and
 * imported values for the day are never overwritten.
 */
import { eq, sql } from 'drizzle-orm';
import { addDays, type IsoDate } from '../../shared/dates';
import { chunkRows, runBatch } from '../db/batch';
import { accountDaily, accounts, holdingDaily, holdings, securities } from '../db/schema';
import type { Tenant } from '../db/tenant';
import type { Deps } from '../ports';
import { closeLookup, ensureCloses } from './pricing';
import { priceOn } from './valuation';

export async function snapshotHousehold(deps: Deps, tenant: Tenant, date: IsoDate): Promise<{ accounts: number; holdings: number }> {
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
  await ensureCloses(deps, publicTickers, addDays(date, -7), date);
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

  const accountDailyRows: (typeof accountDaily.$inferInsert)[] = [];
  const carried: (typeof accountDaily.$inferInsert)[] = [];
  for (const account of accountRows) {
    const fromHoldings = totals.get(account.id);
    if (fromHoldings !== undefined) {
      accountDailyRows.push({
        householdId: tenant.householdId,
        accountId: account.id,
        date,
        balance: fromHoldings,
        currency: account.currency,
        source: account.source === 'manual' ? 'manual' : 'sync',
      });
    } else if (account.balance !== null) {
      (account.source === 'manual' ? carried : accountDailyRows).push({
        householdId: tenant.householdId,
        accountId: account.id,
        date,
        balance: account.balance,
        currency: account.currency,
        source: account.source === 'manual' ? 'manual' : 'sync',
      });
    }
  }

  // Manual accounts tracked by holdings take their balance from them.
  for (const account of accountRows) {
    const fromHoldings = totals.get(account.id);
    if (account.source === 'manual' && fromHoldings !== undefined && fromHoldings !== account.balance) {
      await tenant.db
        .update(accounts)
        .set({ balance: fromHoldings, balanceAsOf: deps.now().getTime() })
        .where(tenant.scope(accounts, eq(accounts.id, account.id)));
    }
  }

  await runBatch(tenant.db, [
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
    ...chunkRows(accountDaily, accountDailyRows).map((chunk) =>
      tenant.db
        .insert(accountDaily)
        .values(chunk)
        .onConflictDoUpdate({
          target: [accountDaily.accountId, accountDaily.date],
          set: { balance: sql`excluded.balance`, source: sql`excluded.source`, estimated: sql`0` },
          setWhere: sql`${accountDaily.source} in ('sync', 'backfill')`,
        }),
    ),
    // Manual balances carry forward but never replace a value entered for the day.
    ...chunkRows(accountDaily, carried).map((chunk) => tenant.db.insert(accountDaily).values(chunk).onConflictDoNothing()),
  ]);

  return { accounts: accountDailyRows.length + carried.length, holdings: holdingDailyRows.length };
}
