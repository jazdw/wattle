/** Working out each day from transactions and one balance known on one date. */
import type { IsoDate } from '../../shared/dates';
import type { ImportedBalances } from '../../shared/schemas';

/**
 * Balances from a closing balance (cents) on `asOf` and the amounts posted:
 * the balance at the end of each day a transaction posted, and on `start`
 * (the day before anything in the file) when given. The import carries each
 * forward to the next. `owed` gives a card's or loan's balance as what's owed.
 */
export function balanceRows(posted: { date: IsoDate; amount: number }[], closing: number, asOf: IsoDate, start: IsoDate | null, owed = false): ImportedBalances['rows'] {
  const sorted = [...posted].sort((a, b) => a.date.localeCompare(b.date));
  // Before the first transaction: the closing balance less everything posted up to its date.
  let balance = closing - sorted.filter((txn) => txn.date <= asOf).reduce((sum, txn) => sum + txn.amount, 0);
  const byDate = new Map<string, number>();
  if (start && start < (sorted[0]?.date ?? asOf)) byDate.set(start, balance);
  for (const txn of sorted) {
    if (txn.date > asOf && !byDate.has(asOf)) byDate.set(asOf, balance);
    balance += txn.amount;
    byDate.set(txn.date, balance);
  }
  if (!byDate.has(asOf) && (sorted.at(-1)?.date ?? asOf) <= asOf) byDate.set(asOf, closing);
  return [...byDate].sort(([a], [b]) => a.localeCompare(b)).map(([date, cents]) => ({ date, balance: (owed ? -cents : cents) / 100 }));
}
