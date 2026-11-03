/**
 * What an import will write, row by row, for the import page's preview: each
 * transaction with the account's cash and the security's shares after it
 * (worked back from the file's positions and cash, as the server does), or
 * each dated balance with its change.
 */
import type { ImportedFile, ImportKind } from '../../shared/schemas';

export interface PreviewRow {
  date: string;
  /** The file's own name for the transaction (BUYMF, Contribution…). */
  label: string;
  kind: ImportKind | null;
  /** The file's id for the security, when it's in one. */
  security: string | null;
  shares: number;
  price: number;
  /** Cash in (+) or out (−), cents, as the account's cash moves. */
  amount: number;
  /** The account's cash after the row, cents (balances: the balance, major units ×100). */
  balance: number;
  /** The security's shares after the row. */
  held: number | null;
}

const CASH_KINDS = new Set<ImportKind>(['income', 'deposit', 'withdrawal', 'fee', 'sweep']);

/** The rows, newest first. */
export function previewRows(file: ImportedFile): PreviewRow[] {
  if (file.kind === 'balances') {
    return file.rows
      .map((row, index) => ({
        date: row.date,
        label: index === 0 ? 'Balance' : 'Change',
        kind: null,
        security: null,
        shares: 0,
        price: 0,
        amount: index === 0 ? 0 : Math.round((row.balance - file.rows[index - 1].balance) * 100),
        balance: Math.round(row.balance * 100),
        held: null,
      }))
      .reverse();
  }
  // As the server counts it: an account holding and moving no cash buys its funds directly.
  const cashless = file.cash === 0 && !file.transactions.some((txn) => CASH_KINDS.has(txn.kind));
  const cashIn = (txn: (typeof file.transactions)[number]) => (cashless || txn.kind === 'sweep' ? 0 : txn.kind === 'fee' ? -Math.abs(txn.amount) : txn.amount);
  const sharesIn = (txn: (typeof file.transactions)[number]) => (txn.security && ['buy', 'sell', 'reinvest', 'transfer'].includes(txn.kind) ? txn.shares : 0);
  const transactions = [...file.transactions].sort((a, b) => a.date.localeCompare(b.date));
  // Walking back from now gives each security's shares and the cash before the file's first transaction.
  let cash = file.cash - transactions.reduce((sum, txn) => sum + cashIn(txn), 0);
  const held = new Map(file.positions.map((row) => [row.security, row.shares]));
  for (const txn of transactions) if (txn.security) held.set(txn.security, (held.get(txn.security) ?? 0) - sharesIn(txn));
  const rows = transactions.map((txn): PreviewRow => {
    cash += cashIn(txn);
    if (txn.security) held.set(txn.security, (held.get(txn.security) ?? 0) + sharesIn(txn));
    return {
      date: txn.date,
      label: txn.label,
      kind: txn.kind,
      security: txn.security,
      shares: sharesIn(txn),
      price: txn.price,
      amount: cashIn(txn),
      balance: cash,
      held: txn.security ? Math.round(held.get(txn.security)! * 1e6) / 1e6 : null,
    };
  });
  return rows.reverse();
}
