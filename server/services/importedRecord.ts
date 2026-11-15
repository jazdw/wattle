/**
 * Which transactions count when an account has more than one source's. The
 * order of trust is import > Plaid's (investment or bank) > a bank report's.
 *
 * Plaid's bank transactions over a report's: on the days Plaid's cover in
 * an account (transaction_ranges, source `bank`), a report's don't count,
 * and each report transaction is paired with Plaid's that is it (by Plaid's
 * id where they share one, else as below) and marked `replacedBy` it, a kind
 * you set and a transfer you decided moving across (pairBank).
 *
 * A file's over the institution's (Plaid's or a bank report's). A file is the institution's own
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
 * characters), a kind you set on it, and a transfer you decided. Plaid's
 * bank transaction gives no text: it keeps its own description, category
 * and merchant, never copied or overwritten, and the file's is read with
 * them (withPlaidDetails), so importing a file can't lose them.
 *
 * Everything that reads transactions as the account's record uses
 * `counted()`; the history rebuild doesn't: it walks back through Plaid's
 * own, and can't overwrite an import's days anyway (shared/quality.ts).
 */
import { and, eq, gte, inArray, isNotNull, isNull, lte, max, min, ne, not, or, sql, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { alias } from 'drizzle-orm/sqlite-core';
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
 * institution's off the import's days and not paired with one of the file's
 * (or a report's paired with Plaid's, or on days Plaid's bank transactions
 * cover). An import's days take over only in an account with a file's
 * transactions: one imported before imports kept them wrote days with none
 * to show.
 */
export function counted(): SQL {
  return sql.raw(
    `("transactions"."source" = 'import' or ("transactions"."replaced_by" is null and not (` +
      `exists (select 1 from "account_daily" "imported" where "imported"."account_id" = "transactions"."account_id" and "imported"."date" = "transactions"."date" and "imported"."source" = 'import')` +
      ` and exists (select 1 from "transactions" "kept" where "kept"."household_id" = "transactions"."household_id" and "kept"."account_id" = "transactions"."account_id" and "kept"."source" = 'import'))` +
      ` and not ("transactions"."source" = 'report' and exists (select 1 from "transaction_ranges" "feed" where "feed"."household_id" = "transactions"."household_id" and "feed"."account_id" = "transactions"."account_id" and "feed"."source" = 'bank' and "feed"."from" <= "transactions"."date" and "feed"."to" >= "transactions"."date"))))`,
  );
}

/**
 * A counted transaction read with Plaid's details: a file's paired with
 * Plaid's bank transaction (its twin, `replacedBy` the file's) shows Plaid's
 * description, category and merchant, its own text kept beside them; any
 * other shows its own. Left-join `twin` on `on`.
 */
export function withPlaidDetails() {
  const twin = alias(transactions, 'twin');
  return {
    twin,
    on: and(eq(twin.replacedBy, transactions.id), eq(twin.source, 'bank'), eq(twin.householdId, transactions.householdId))!,
    columns: {
      description: sql<string | null>`coalesce(${twin.description}, ${transactions.description})`,
      // A file's MEMO goes with its own text, not with Plaid's description.
      memo: sql<string | null>`case when ${twin.id} is null then ${transactions.memo} end`,
      ownDescription: transactions.description,
      ownMemo: transactions.memo,
      plaidCategory: sql<string | null>`coalesce(${twin.plaidCategory}, ${transactions.plaidCategory})`,
      plaidCategoryDetailed: sql<string | null>`coalesce(${twin.plaidCategoryDetailed}, ${transactions.plaidCategoryDetailed})`,
      merchant: sql<string | null>`coalesce(${twin.merchantName}, ${transactions.merchantName})`,
      twinId: twin.id,
    },
    /** Words searched for in either text, and the merchant. */
    matches: (pattern: string) =>
      sql`(${transactions.description} like ${pattern} escape '\\' or ${transactions.memo} like ${pattern} escape '\\' or ${twin.description} like ${pattern} escape '\\' or ${transactions.merchantName} like ${pattern} escape '\\' or ${twin.merchantName} like ${pattern} escape '\\')`,
  };
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
 * Statements setting a column of many transactions, each to its own value:
 * `case id when … then … end`, 30 to a statement (3 parameters each, under
 * D1's 100). One UPDATE apiece would run thousands of queries on a first
 * pairing, past D1's 1,000 per invocation.
 */
function setEach(tenant: Tenant, column: 'replacedBy' | 'kind' | 'description', values: Map<string, string | null>, where?: SQL): BatchItem<'sqlite'>[] {
  return inChunks([...values], 30).map((chunk) =>
    tenant.db
      .update(transactions)
      .set({ [column]: sql`case ${transactions.id} ${sql.join(chunk.map(([id, value]) => sql`when ${id} then ${value}`), sql` `)} end` })
      .where(tenant.scope(transactions, inArray(transactions.id, chunk.map(([id]) => id)), where)),
  );
}

/**
 * Pair each account's imported transactions with the institution's (see
 * above). Transfers on the institution's that no longer count are settled
 * afterwards (settleTransfers).
 */
export async function pairImported(tenant: Tenant): Promise<{ paired: number }> {
  const replacer = alias(transactions, 'replacer');
  const ranges = await tenant.db
    .select({ accountId: accountDaily.accountId, from: min(accountDaily.date), to: max(accountDaily.date) })
    .from(accountDaily)
    .where(tenant.scope(accountDaily, eq(accountDaily.source, 'import')))
    .groupBy(accountDaily.accountId);
  const replacedBy = new Map<string, string | null>();
  const texts = new Map<string, string | null>();
  const kinds = new Map<string, string | null>();
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
        replacedBySource: replacer.source,
      })
      .from(transactions)
      .leftJoin(securities, eq(securities.id, transactions.securityId))
      .leftJoin(replacer, eq(replacer.id, transactions.replacedBy))
      .where(tenant.scope(transactions, eq(transactions.accountId, accountId), gte(transactions.date, addDays(from, -OVERLAP_DAYS)), lte(transactions.date, addDays(to, OVERLAP_DAYS))));
    // As compared: a cash fund (the sweep, Plaid's cash) as no security, and a fee as money out (./backfill paidOut: some feeds sign them as money in).
    const compared = rows.map((row) => ({
      ...row,
      securityId: row.securityId !== null && isCashSecurity({ ticker: row.ticker, type: row.securityType }) ? null : row.securityId,
      amount: row.source !== 'import' && row.type === 'fee' ? Math.abs(row.amount) : row.amount,
    }));
    const file = compared.filter((row) => row.source === 'import');
    // A report's paired with Plaid's bank transaction is that one's (pairBank): the file's pairs with Plaid's.
    const feed = compared.filter((row) => row.source !== 'import' && !(row.source === 'report' && row.replacedBySource === 'bank'));
    // An import that kept no transactions (from before imports did) takes nothing over.
    if (!file.length && !(await tenant.db.select({ id: transactions.id }).from(transactions).where(tenant.scope(transactions, eq(transactions.accountId, accountId), eq(transactions.source, 'import'))).limit(1)).length) continue;
    const pairs = pairUp(file, feed);
    paired += pairs.size;
    for (const row of feed) {
      const ours = pairs.get(row)?.id ?? null;
      if (ours !== row.replacedBy) replacedBy.set(row.id, ours);
    }
    for (const [theirs, ours] of pairs) {
      // Plaid's bank transaction keeps its text, read with the file's (withPlaidDetails).
      const text = theirs.source === 'bank' ? null : betterText(ours, theirs);
      if (text && (text.description !== ours.description || ours.memo !== null)) texts.set(ours.id, text.description);
      if (theirs.kind && !ours.kind) kinds.set(ours.id, theirs.kind);
    }
  }
  const statements = [
    ...setEach(tenant, 'replacedBy', replacedBy),
    ...setEach(tenant, 'description', texts),
    // The memo is in the institution's description now.
    ...inChunks([...texts.keys()]).map((ids) => tenant.db.update(transactions).set({ memo: null }).where(tenant.scope(transactions, inArray(transactions.id, ids)))),
    ...setEach(tenant, 'kind', kinds, isNull(transactions.kind)),
  ];
  if (statements.length > 0) await runAtomic(tenant.db, statements);
  return { paired };
}

/**
 * Pair each account's bank report transactions with Plaid's bank
 * transactions (see above): by Plaid's id where they share one, else the
 * same amount within five days (pairUp). A paired report transaction is
 * marked `replacedBy` Plaid's, which takes a kind you set on it; transfers
 * are settled afterwards (settleTransfers).
 */
export async function pairBank(tenant: Tenant): Promise<{ paired: number }> {
  const withBank = await tenant.db
    .selectDistinct({ accountId: transactions.accountId })
    .from(transactions)
    .where(tenant.scope(transactions, eq(transactions.source, 'bank')));
  const replacedBy = new Map<string, string | null>();
  const kinds = new Map<string, string | null>();
  let paired = 0;
  for (const { accountId } of withBank) {
    const rows = await tenant.db
      .select({
        id: transactions.id,
        source: transactions.source,
        externalId: transactions.externalId,
        date: transactions.date,
        amount: transactions.amount,
        description: transactions.description,
        memo: transactions.memo,
        kind: transactions.kind,
        replacedBy: transactions.replacedBy,
      })
      .from(transactions)
      .where(tenant.scope(transactions, eq(transactions.accountId, accountId), inArray(transactions.source, ['bank', 'report'])));
    const bank = rows.filter((row) => row.source === 'bank');
    const reports = rows.filter((row) => row.source === 'report');
    if (reports.length === 0) continue;
    const bankIds = new Set(bank.map((row) => row.id));
    // Plaid's own id first, then alike (one each), within each amount: pairUp compares every pair it's given.
    const byExternal = new Map(bank.map((row) => [row.externalId, row]));
    const pairs = new Map<(typeof rows)[number], (typeof rows)[number]>();
    for (const report of reports) {
      const twin = byExternal.get(report.externalId);
      if (twin) pairs.set(report, twin);
    }
    const taken = new Set(pairs.values());
    const byAmount = new Map<number, { bank: typeof rows; reports: typeof rows }>();
    for (const row of bank) if (!taken.has(row)) (byAmount.get(row.amount) ?? byAmount.set(row.amount, { bank: [], reports: [] }).get(row.amount)!).bank.push(row);
    for (const row of reports) if (!pairs.has(row)) byAmount.get(row.amount)?.reports.push(row);
    for (const group of byAmount.values()) for (const [report, twin] of pairUp(group.bank, group.reports)) pairs.set(report, twin);
    paired += pairs.size;
    for (const report of reports) {
      const twin = pairs.get(report);
      // Paired, or no longer paired with Plaid's (one removed or changed); one replaced by a file's stays so.
      if (twin && report.replacedBy !== twin.id) {
        replacedBy.set(report.id, twin.id);
        if (report.kind && !twin.kind) kinds.set(twin.id, report.kind);
      } else if (!twin && report.replacedBy !== null && bankIds.has(report.replacedBy)) replacedBy.set(report.id, null);
    }
  }
  const statements = [...setEach(tenant, 'replacedBy', replacedBy), ...setEach(tenant, 'kind', kinds, isNull(transactions.kind))];
  if (statements.length > 0) await runAtomic(tenant.db, statements);
  return { paired };
}

/**
 * After the pairing: a transfer you confirmed or rejected on a transaction
 * that another replaced moves to the one that counts in its place (along the
 * chain: a report's to Plaid's to a file's), unless that one has its own;
 * automatic and suggested ones on transactions that don't count go, for
 * matching to redo. A handful of queries, however many were paired.
 */
export async function settleTransfers(tenant: Tenant): Promise<void> {
  const replaced = tenant.db.select({ id: transactions.id }).from(transactions).where(tenant.scope(transactions, isNotNull(transactions.replacedBy)));
  const decided = await tenant.db
    .select()
    .from(transfers)
    .where(tenant.scope(transfers, inArray(transfers.status, ['confirmed', 'rejected']), or(inArray(transfers.outId, replaced), inArray(transfers.inId, replaced))));
  const statements: BatchItem<'sqlite'>[] = [];
  if (decided.length > 0) {
    // Each side's replacement, followed to the end of its chain.
    const next = new Map<string, string | null>();
    let unknown = [...new Set(decided.flatMap((row) => [row.outId, row.inId]))];
    for (let depth = 0; unknown.length > 0 && depth < 4; depth++) {
      const found: string[] = [];
      for (const ids of inChunks(unknown)) {
        for (const row of await tenant.db.select({ id: transactions.id, replacedBy: transactions.replacedBy }).from(transactions).where(tenant.scope(transactions, inArray(transactions.id, ids)))) {
          next.set(row.id, row.replacedBy);
          if (row.replacedBy && !next.has(row.replacedBy)) found.push(row.replacedBy);
        }
      }
      unknown = found;
    }
    const counting = (id: string) => {
      let at = id;
      for (let step = 0; step < 4 && next.get(at); step++) at = next.get(at)!;
      return at;
    };
    const targets = [...new Set(decided.flatMap((row) => [counting(row.outId), counting(row.inId)]))];
    const theirOwn = new Set<string>();
    for (const ids of inChunks(targets, 45)) {
      const rows = await tenant.db
        .select({ outId: transfers.outId, inId: transfers.inId })
        .from(transfers)
        .where(tenant.scope(transfers, ne(transfers.status, 'suggested'), or(inArray(transfers.outId, ids), inArray(transfers.inId, ids))));
      for (const row of rows) theirOwn.add(row.outId).add(row.inId);
    }
    for (const row of decided) {
      const outId = counting(row.outId);
      const inId = counting(row.inId);
      if ((outId === row.outId && inId === row.inId) || (outId !== row.outId && theirOwn.has(outId)) || (inId !== row.inId && theirOwn.has(inId))) continue;
      theirOwn.add(outId).add(inId);
      statements.push(tenant.db.update(transfers).set({ outId, inId }).where(tenant.scope(transfers, eq(transfers.id, row.id))));
    }
  }
  const uncounted = tenant.db.select({ id: transactions.id }).from(transactions).where(tenant.scope(transactions, not(counted())));
  statements.push(tenant.db.delete(transfers).where(tenant.scope(transfers, inArray(transfers.status, ['auto', 'suggested']), or(inArray(transfers.outId, uncounted), inArray(transfers.inId, uncounted)))));
  await runAtomic(tenant.db, statements);
}
