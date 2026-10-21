/**
 * Dated balances entered by hand or imported from a CSV. One path for both,
 * so a manual account's current balance always follows its newest entry.
 */
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { marketDate } from '../../shared/dates';
import { toMinor } from '../../shared/money';
import { chunkRows, runAtomic } from '../db/batch';
import { accountDaily, accounts } from '../db/schema';
import type { Tenant } from '../db/tenant';
import type { Deps } from '../ports';
import { accountLease, Lease } from './lease';
import { snapshotHousehold } from './snapshots';

const LIABILITY_TYPES = new Set(['credit', 'loan']);

/** Minor units, liabilities negative (entered as positive amounts owed). */
export function signedBalance(type: string, amount: number): number {
  const minor = toMinor(amount);
  return LIABILITY_TYPES.has(type) ? -Math.abs(minor) : minor;
}

type Account = typeof accounts.$inferSelect;

/**
 * Write dated balances (major units) for an account, all or none.
 * - 'manual' (Record a balance): replaces whatever that day held.
 * - 'import' (CSV): fills gaps and replaces estimates (backfilled, or carried
 *   forward while syncing failed) and earlier imports;
 *   with `overwrite`, replaces synced and recorded values too.
 * For a manual account, the newest recorded or imported day is its current
 * balance; when that changes, later carried-forward snapshot copies are
 * dropped and today's snapshot is redone.
 */
export async function writeBalances(
  deps: Deps,
  tenant: Tenant,
  account: Account,
  entries: { date: string; balance: number }[],
  source: 'manual' | 'import',
  overwrite = false,
): Promise<number> {
  // Last value wins when several entries are for one day.
  const byDate = new Map(entries.map((entry) => [entry.date, entry.balance]));
  const rows = [...byDate].map(([date, balance]) => ({
    householdId: tenant.householdId,
    accountId: account.id,
    date,
    balance: signedBalance(account.type, balance),
    currency: account.currency,
    source,
  }));
  const write = () =>
    chunkRows(accountDaily, rows).map((chunk) =>
      tenant.db
        .insert(accountDaily)
        .values(chunk)
        .onConflictDoUpdate({
          target: [accountDaily.accountId, accountDaily.date],
          set: { balance: sql`excluded.balance`, source: sql`excluded.source`, estimated: sql`0` },
          setWhere:
            source === 'manual' || overwrite
              ? sql`1 = 1`
              : sql`${accountDaily.source} in ('backfill', 'import') or (${accountDaily.source} = 'sync' and ${accountDaily.estimated} = 1)`,
        }),
    );

  // A linked account's current balance comes from the institution.
  if (account.source !== 'manual') {
    await runAtomic(tenant.db, write());
    return rows.length;
  }

  // One change to the account at a time (two writes at once could otherwise
  // leave an older entry as the current balance).
  const lease = await Lease.acquireOrBusy(deps, tenant, accountLease(account.id), 'Someone else is updating this account. Try again in a moment.');
  let changed = false;
  try {
    const newest = () =>
      tenant.db
        .select({ date: accountDaily.date, balance: accountDaily.balance })
        .from(accountDaily)
        .where(tenant.scope(accountDaily, eq(accountDaily.accountId, account.id), inArray(accountDaily.source, ['manual', 'import'])))
        .orderBy(desc(accountDaily.date))
        .limit(1)
        .then(([row]) => row);
    const before = await newest();
    await lease.renew();
    await runAtomic(tenant.db, write());
    const after = await newest();
    changed = !!after && (after.date !== before?.date || after.balance !== before?.balance || account.balance === null);
    if (changed) {
      await lease.renew();
      await runAtomic(tenant.db, [
        tenant.db.update(accounts).set({ balance: after.balance, balanceAsOf: deps.now().getTime() }).where(tenant.scope(accounts, eq(accounts.id, account.id))),
        // Carried-forward snapshot copies after it are stale now.
        tenant.db
          .delete(accountDaily)
          .where(tenant.scope(accountDaily, eq(accountDaily.accountId, account.id), eq(accountDaily.source, 'sync'), sql`${accountDaily.date} > ${after.date}`)),
      ]);
    }
  } finally {
    await lease.forceRelease();
  }
  if (changed) await snapshotHousehold(deps, tenant, marketDate(deps.now()));
  return rows.length;
}
