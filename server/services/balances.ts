/**
 * Dated balances entered by hand or imported from a CSV. One path for both,
 * so a manual account's current balance always follows its newest entry.
 */
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { addDays, marketDate } from '../../shared/dates';
import { toMinor } from '../../shared/money';
import { chunkRows, runAtomic } from '../db/batch';
import { accountDaily, accounts } from '../db/schema';
import type { Tenant } from '../db/tenant';
import type { Deps } from '../ports';
import { accountLease, Lease } from './lease';
import { QUALITY_SET, replaceWhere } from './quality';
import { snapshotHousehold } from './snapshots';

const LIABILITY_TYPES = new Set(['credit', 'loan']);

/** Minor units, liabilities negative (entered as positive amounts owed). */
export function signedBalance(type: string, amount: number): number {
  const minor = toMinor(amount);
  return LIABILITY_TYPES.has(type) ? -Math.abs(minor) : minor;
}

type Account = typeof accounts.$inferSelect;

/** Add each missing day between the first and last date, carrying the previous day's balance. */
function fillDays(byDate: Map<string, number>) {
  const dates = [...byDate.keys()].sort();
  for (let index = 1; index < dates.length; index++) {
    const balance = byDate.get(dates[index - 1])!;
    for (let day = addDays(dates[index - 1], 1); day < dates[index]; day = addDays(day, 1)) byDate.set(day, balance);
  }
}

/**
 * Write dated balances (major units) for an account, all or none.
 * - 'manual' (Record a balance) and 'import' (CSV) replace whatever those
 *   days held: your values are trusted over anything from the institution
 *   (shared/quality.ts), and the later of an entry and an import wins.
 * - An import's balance holds until the file's next one, so every day from
 *   its first date to its last is written (a sparse file would otherwise
 *   leave old values in between).
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
): Promise<number> {
  // Last value wins when several entries are for one day.
  const byDate = new Map(entries.map((entry) => [entry.date, entry.balance]));
  if (source === 'import') fillDays(byDate);
  const rows = [...byDate].map(([date, balance]) => ({
    householdId: tenant.householdId,
    accountId: account.id,
    date,
    balance: signedBalance(account.type, balance),
    currency: account.currency,
    source,
    priceSource: null,
    unmatched: false,
  }));
  const write = () =>
    chunkRows(accountDaily, rows).map((chunk) =>
      tenant.db
        .insert(accountDaily)
        .values(chunk)
        .onConflictDoUpdate({
          target: [accountDaily.accountId, accountDaily.date],
          set: { balance: sql`excluded.balance`, ...QUALITY_SET },
          setWhere: replaceWhere(accountDaily.source),
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
          .where(tenant.scope(accountDaily, eq(accountDaily.accountId, account.id), inArray(accountDaily.source, ['snapshot', 'carried']), sql`${accountDaily.date} > ${after.date}`)),
      ]);
    }
  } finally {
    await lease.forceRelease();
  }
  if (changed) await snapshotHousehold(deps, tenant, marketDate(deps.now()));
  return rows.length;
}
