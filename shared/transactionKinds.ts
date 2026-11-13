/**
 * What a transaction does, whatever it came from. You can set one on any
 * transaction; otherwise it's worked out here, when read: an imported file's
 * own mapping (its readers map the file's types: src/lib/imports.ts), Plaid's
 * investment type and subtype, or a bank transaction's sign. So a better
 * mapping applies to everything already stored.
 */

export const TRANSACTION_KINDS = ['buy', 'sell', 'reinvest', 'income', 'deposit', 'withdrawal', 'fee', 'transfer', 'sweep'] as const;
export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

/** Each kind in words. */
export const KIND_WORDS: Record<TransactionKind, string> = {
  buy: 'Purchase',
  sell: 'Sale',
  reinvest: 'Reinvested dividend',
  income: 'Dividend or interest',
  deposit: 'Money in',
  withdrawal: 'Money out',
  fee: 'Fee',
  transfer: 'Shares moved',
  sweep: 'Moved within cash',
};

export interface KindFacts {
  source: 'plaid' | 'report' | 'import';
  /** Set by you. */
  kind: TransactionKind | null;
  type: string | null;
  subtype: string | null;
  /** Cents, positive when money leaves the account (Plaid's convention). */
  amount: number;
  quantity: number;
  description: string | null;
}

/** Plaid's subtypes for money earned: under `cash`, and (for some institutions) under `fee` too. */
const INCOME_SUBTYPES = new Set(['dividend', 'qualified dividend', 'non-qualified dividend', 'interest', 'interest receivable', 'long-term capital gain', 'short-term capital gain', 'unqualified gain']);
const FEE_SUBTYPES = new Set(['account fee', 'fund fee', 'legal fee', 'management fee', 'margin expense', 'miscellaneous fee', 'transfer fee', 'trust fee', 'tax', 'tax withheld', 'non-resident tax']);
/** Cash in or out of the account by its sign. */
const MONEY_SUBTYPES = new Set(['contribution', 'deposit', 'withdrawal', 'distribution', 'loan payment']);

const bySign = (amount: number): TransactionKind => (amount > 0 ? 'withdrawal' : 'deposit');

const isKind = (value: string | null): value is TransactionKind => (TRANSACTION_KINDS as readonly (string | null)[]).includes(value);

/**
 * A transaction's kind: as set by you, else from its type. Null when it
 * can't be told (a cancellation, a type nobody maps yet): it needs one set
 * by you. `isCash`: the transaction's security is the account's cash (a
 * money market fund held as cash).
 */
export function kindOf(row: KindFacts, isCash = false): TransactionKind | null {
  if (row.kind) return row.kind;
  if (row.source === 'import') return isKind(row.subtype) ? row.subtype : null;
  if (row.source === 'report') return bankKind(row.amount, row.description);
  return plaidKind(row.type, row.subtype, row.amount, row.quantity, isCash);
}

/** A bank's transaction, from its sign and description. A card's purchases are money out and its payments money in, the same rule. */
export function bankKind(amount: number, description: string | null): TransactionKind {
  const text = description ?? '';
  if (amount < 0) return /\binterest\b/i.test(text) ? 'income' : 'deposit';
  return /\b(fee|service charge|interest)\b/i.test(text) ? 'fee' : 'withdrawal';
}

/** A Plaid investment transaction, by its subtype first (they're more telling than its type). */
export function plaidKind(type: string | null, subtype: string | null, amount: number, quantity: number, isCash: boolean): TransactionKind | null {
  const sub = (subtype ?? '').toLowerCase();
  const kind = (type ?? '').toLowerCase();
  if (kind === 'cancel') return null;
  if (sub.includes('reinvestment')) return 'reinvest';
  if (kind === 'buy' || kind === 'sell') return isCash ? 'sweep' : kind;
  // Interest paid out (on a margin loan) is a cost.
  if (INCOME_SUBTYPES.has(sub)) return amount <= 0 ? 'income' : 'fee';
  if (FEE_SUBTYPES.has(sub) || (kind === 'fee' && !sub)) return 'fee';
  if (MONEY_SUBTYPES.has(sub)) return bySign(amount);
  if (kind === 'transfer') return quantity !== 0 ? 'transfer' : amount !== 0 ? bySign(amount) : 'transfer';
  if (kind === 'cash' && !['adjustment', 'pending credit', 'pending debit', 'rebalance', 'return of principal'].includes(sub)) return bySign(amount);
  return null;
}

/** Days apart that a transfer you link by hand may be: its two sides, either way. */
export const TRANSFER_LINK_DAYS = 10;
