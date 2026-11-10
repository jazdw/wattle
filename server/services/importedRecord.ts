/**
 * Which transactions count when an account has both a file's and the
 * institution's (Plaid's or a bank report's). A file is the institution's own
 * record, so on the days an import wrote, its transactions count and the
 * institution's are kept but left out; on every other day the institution's
 * count. Nothing is deleted: a sync sends its transactions again anyway, and
 * removing or replacing the import brings them back.
 *
 * The two can date the same transaction a day or two apart (a feed often
 * shows it late), so one just after the file's last day could count twice.
 * The pairing (run before transfers are matched) finds the institution's
 * transaction for each of the file's: the same amount, security and share
 * count within five days, there being no id in common (Plaid's are its own).
 * A paired one is marked `replacedBy` the file's and left out wherever it's
 * dated, and gives the file's its description when that's the file's text
 * in full (a bank's file splits it across NAME and MEMO, cutting NAME at 32
 * characters), a kind you set on it, and a transfer you decided.
 *
 * Everything that reads transactions as the account's record uses
 * `counted()`; the history rebuild doesn't: it walks back through Plaid's
 * own, and can't overwrite an import's days anyway (shared/quality.ts).
 */
import { and, eq, gte, inArray, isNull, lte, max, min, ne, or, sql, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { addDays } from '../../shared/dates';
import { inChunks, runAtomic } from '../db/batch';
import { accountDaily, securities, transactions, transfers } from '../db/schema';
import type { Tenant } from '../db/tenant';
import { isCashSecurity } from './valuation';

/** Days apart the file and the institution can date one transaction. */
export const OVERLAP_DAYS = 5;

const SHARES_EPSILON = 0.001;

/**
 * The condition for a transaction that counts: the file's, or the
 * institution's off the import's days and not paired with one of the file's.
 * An import's days take over only in an account with a file's transactions:
 * one imported before imports kept them wrote days with none to show.
 */
export function counted(): SQL {
  return sql.raw(
    `("transactions"."source" = 'import' or ("transactions"."replaced_by" is null and not (` +
      `exists (select 1 from "account_daily" "imported" where "imported"."account_id" = "transactions"."account_id" and "imported"."date" = "transactions"."date" and "imported"."source" = 'import')` +
      ` and exists (select 1 from "transactions" "kept" where "kept"."household_id" = "transactions"."household_id" and "kept"."account_id" = "transactions"."account_id" and "kept"."source" = 'import'))))`,
  );
}

export interface Comparable {
  date: string;
  /** Cents, positive out. */
  amount?: number | null;
  securityId?: string | null;
  quantity?: number | null;
}

const daysBetween = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

/**
 * The same transaction: the same amount, share count and security, within
 * five days. Cash moving with no shares may name a security on one side only
 * (an institution's fee or dividend "on" a holding a file lists as cash), and
 * a cash fund counts as none (see pairImported).
 */
export function sameTransaction(a: Comparable, b: Comparable): boolean {
  const [x, y] = [a.securityId ?? null, b.securityId ?? null];
  const cashOnly = Math.abs(a.quantity ?? 0) <= SHARES_EPSILON && Math.abs(b.quantity ?? 0) <= SHARES_EPSILON;
  return (
    (a.amount ?? 0) === (b.amount ?? 0) &&
    (x === y || (cashOnly && (x === null || y === null))) &&
    Math.abs(Math.abs(a.quantity ?? 0) - Math.abs(b.quantity ?? 0)) <= SHARES_EPSILON &&
    daysBetween(a.date, b.date) <= OVERLAP_DAYS
  );
}

/** Each of the feed's with the file's it is: one each at most, the nearest in date (two alike with one in the feed keep the other). */
export function pairUp<F extends Comparable & Described, T extends Comparable & Described>(fileRows: F[], feedRows: T[]): Map<T, F> {
  const pairs = new Map<T, F>();
  const taken = new Set<F>();
  for (const feed of [...feedRows].sort((a, b) => a.date.localeCompare(b.date))) {
    // Of several alike (two transfers of one amount on a day), the one whose description agrees, then the nearest.
    const match = fileRows
      .filter((row) => !taken.has(row) && sameTransaction(row, feed))
      .sort((a, b) => Number(agrees(b, feed)) - Number(agrees(a, feed)) || daysBetween(a.date, feed.date) - daysBetween(b.date, feed.date))[0];
    if (!match) continue;
    pairs.set(feed, match);
    taken.add(match);
  }
  return pairs;
}

interface Described {
  description?: string | null;
  memo?: string | null;
}

/** A transaction's text as compared: its description and memo together, spacing left out (a file pads and splits them; the institution's has the same characters in one). */
const squashed = (row: Described) => `${row.description ?? ''}${row.memo ?? ''}`.replace(/\s+/g, '');

/** One's text is the start of the other's (or they're the same). */
function agrees(file: Described, feed: Described): boolean {
  const [a, b] = [squashed(file), squashed(feed)];
  return a.length > 0 && b.length > 0 && (b.startsWith(a) || a.startsWith(b));
}

/** The institution's description in place of the file's description and memo, when it has all of their text (or they have none); null to keep the file's. */
export function betterText(file: Described, feed: Described): { description: string; memo: null } | null {
  if (!feed.description) return null;
  return squashed(feed).startsWith(squashed(file)) ? { description: feed.description, memo: null } : null;
}

/**
 * Pair each account's imported transactions with the institution's (see
 * above), and remove automatic and suggested transfers on the institution's
 * that no longer count: matching then works on the file's.
 */
export async function pairImported(tenant: Tenant): Promise<{ paired: number }> {
  const ranges = await tenant.db
    .select({ accountId: accountDaily.accountId, from: min(accountDaily.date), to: max(accountDaily.date) })
    .from(accountDaily)
    .where(tenant.scope(accountDaily, eq(accountDaily.source, 'import')))
    .groupBy(accountDaily.accountId);
  const statements: BatchItem<'sqlite'>[] = [];
  let paired = 0;
  for (const { accountId, from, to } of ranges) {
    if (!from || !to) continue;
    const rows = await tenant.db
      .select({
        id: transactions.id,
        source: transactions.source,
        date: transactions.date,
        amount: transactions.amount,
        securityId: transactions.securityId,
        quantity: transactions.quantity,
        description: transactions.description,
        memo: transactions.memo,
        kind: transactions.kind,
        replacedBy: transactions.replacedBy,
        type: transactions.type,
        ticker: securities.ticker,
        securityType: securities.type,
      })
      .from(transactions)
      .leftJoin(securities, eq(securities.id, transactions.securityId))
      .where(tenant.scope(transactions, eq(transactions.accountId, accountId), gte(transactions.date, addDays(from, -OVERLAP_DAYS)), lte(transactions.date, addDays(to, OVERLAP_DAYS))));
    // As compared: a cash fund (the sweep, Plaid's cash) as no security, and a fee as money out (./backfill paidOut: some feeds sign them as money in).
    const compared = rows.map((row) => ({
      ...row,
      securityId: row.securityId !== null && isCashSecurity({ ticker: row.ticker, type: row.securityType }) ? null : row.securityId,
      amount: row.source !== 'import' && row.type === 'fee' ? Math.abs(row.amount) : row.amount,
    }));
    const file = compared.filter((row) => row.source === 'import');
    const feed = compared.filter((row) => row.source !== 'import');
    // An import that kept no transactions (from before imports did) takes nothing over.
    if (!file.length && !(await tenant.db.select({ id: transactions.id }).from(transactions).where(tenant.scope(transactions, eq(transactions.accountId, accountId), eq(transactions.source, 'import'))).limit(1)).length) continue;
    const pairs = pairUp(file, feed);
    paired += pairs.size;
    for (const row of feed) {
      const replacedBy = pairs.get(row)?.id ?? null;
      if (replacedBy !== row.replacedBy) statements.push(tenant.db.update(transactions).set({ replacedBy }).where(tenant.scope(transactions, eq(transactions.id, row.id))));
    }
    for (const [theirs, ours] of pairs) {
      const text = betterText(ours, theirs);
      if (text && (text.description !== ours.description || ours.memo !== null)) statements.push(tenant.db.update(transactions).set(text).where(tenant.scope(transactions, eq(transactions.id, ours.id))));
      if (theirs.kind && !ours.kind) statements.push(tenant.db.update(transactions).set({ kind: theirs.kind }).where(tenant.scope(transactions, eq(transactions.id, ours.id), isNull(transactions.kind))));
    }
    statements.push(...(await movedTransfers(tenant, pairs)));
    // The institution's that no longer count: on the import's days, or paired.
    const left = feed.filter((row) => pairs.has(row) || (row.date >= from && row.date <= to)).map((row) => row.id);
    for (const ids of inChunks(left, 45)) {
      statements.push(tenant.db.delete(transfers).where(tenant.scope(transfers, inArray(transfers.status, ['auto', 'suggested']), or(inArray(transfers.outId, ids), inArray(transfers.inId, ids)))));
    }
  }
  if (statements.length > 0) await runAtomic(tenant.db, statements);
  return { paired };
}

/** Transfers you confirmed or rejected on the institution's transactions, moved to the file's they're paired with (unless it has its own). */
async function movedTransfers(tenant: Tenant, pairs: Map<{ id: string }, { id: string }>): Promise<BatchItem<'sqlite'>[]> {
  const fileOf = new Map([...pairs].map(([theirs, ours]) => [theirs.id, ours.id]));
  if (fileOf.size === 0) return [];
  const decided = [];
  for (const ids of inChunks([...fileOf.keys()], 45)) {
    decided.push(
      ...(await tenant.db
        .select()
        .from(transfers)
        .where(tenant.scope(transfers, inArray(transfers.status, ['confirmed', 'rejected']), or(inArray(transfers.outId, ids), inArray(transfers.inId, ids))))),
    );
  }
  if (decided.length === 0) return [];
  const files = [...new Set(decided.flatMap((row) => [fileOf.get(row.outId), fileOf.get(row.inId)]).filter((id): id is string => Boolean(id)))];
  const theirOwn = new Set<string>();
  for (const ids of inChunks(files, 45)) {
    const rows = await tenant.db
      .select({ outId: transfers.outId, inId: transfers.inId })
      .from(transfers)
      .where(tenant.scope(transfers, ne(transfers.status, 'suggested'), or(inArray(transfers.outId, ids), inArray(transfers.inId, ids))));
    for (const row of rows) theirOwn.add(row.outId).add(row.inId);
  }
  return decided.flatMap((row) => {
    const outId = fileOf.get(row.outId) ?? row.outId;
    const inId = fileOf.get(row.inId) ?? row.inId;
    if ((outId !== row.outId && theirOwn.has(outId)) || (inId !== row.inId && theirOwn.has(inId))) return [];
    theirOwn.add(outId).add(inId);
    return [tenant.db.update(transfers).set({ outId, inId }).where(tenant.scope(transfers, and(eq(transfers.id, row.id))!))];
  });
}
