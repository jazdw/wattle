/**
 * Working out each day from transactions and one balance known on one date.
 * Forwards from a balance at the start and backwards from one at the end are
 * the same sum (end = start + everything between), so a known start is turned
 * into the end it leads to and the rest works back from there, as the
 * server's walk does.
 */
import { addDays, type IsoDate } from '../../shared/dates';
import { toMinor } from '../../shared/money';
import type { ImportedBalances, ImportedHoldings } from '../../shared/schemas';
import type { FileAccount, ReadTransaction } from './imports';

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

/** Transactions with no balance in the file (a CSV export): one known balance, typed in, works out every day. */
export type Unanchored =
  | { kind: 'cash'; transactions: ReadTransaction[] }
  /** `moneyMoves`: the file moves cash (deposits, income, fees…), so the account's cash is asked for too; else trades buy and sell its funds directly. */
  | { kind: 'holdings'; securities: ImportedHoldings['securities']; transactions: ReadTransaction[]; moneyMoves: boolean };

/** What's known, in major units: before the file's first transaction or after its last. Null where not given yet. */
export interface Known {
  at: 'start' | 'end';
  cash: number | null;
  shares: Record<string, number | null>;
}

/** How a transaction changes the account's cash in cents, as the server counts it. */
const cashEffect = (txn: ReadTransaction) => (txn.kind === 'sweep' ? 0 : txn.kind === 'fee' ? -Math.abs(txn.amount) : txn.amount);

/** The account's file once its known balance is given; null until everything it needs is. */
export function withKnown(account: FileAccount, known: Known | undefined): FileAccount | null {
  const pending = account.unanchored;
  if (!pending) return account;
  const { transactions } = pending;
  if (!known || transactions.length === 0) return null;
  const first = transactions[0].date;
  const asOf = transactions.at(-1)!.date;
  if (pending.kind === 'cash') {
    if (known.cash === null) return null;
    const total = transactions.reduce((sum, txn) => sum + cashEffect(txn), 0);
    const closing = toMinor(known.cash) + (known.at === 'start' ? total : 0);
    const posted = transactions.map((txn) => ({ date: txn.date, amount: cashEffect(txn) }));
    const rows = balanceRows(posted, closing, asOf, known.at === 'start' ? addDays(first, -1) : null);
    const kept = transactions.map((txn) => ({ ...(txn.id ? { id: txn.id } : {}), date: txn.date, kind: txn.kind, label: txn.label, ...(txn.description ? { description: txn.description } : {}), amount: cashEffect(txn) }));
    return { ...account, file: { kind: 'balances', currency: account.file.currency, rows, transactions: kept } };
  }
  if (pending.moneyMoves && known.cash === null) return null;
  if (pending.securities.some((security) => known.shares[security.id] == null)) return null;
  const forward = known.at === 'start';
  const positions = pending.securities.flatMap((security) => {
    const traded = transactions.filter((txn) => txn.security === security.id);
    const shares = known.shares[security.id]! + (forward ? traded.reduce((sum, txn) => sum + txn.shares, 0) : 0);
    const price = traded.filter((txn) => txn.price > 0).at(-1)?.price;
    return Math.abs(shares) < 1e-6 ? [] : [{ security: security.id, shares: Math.round(shares * 1e6) / 1e6, ...(price ? { price } : {}) }];
  });
  const cash = pending.moneyMoves ? toMinor(known.cash!) + (forward ? transactions.reduce((sum, txn) => sum + cashEffect(txn), 0) : 0) : 0;
  const file: ImportedHoldings = { kind: 'holdings', currency: account.file.currency, asOf, securities: pending.securities, positions, cash, transactions };
  return { ...account, file };
}
