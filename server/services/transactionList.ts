/**
 * An account's transactions, or the whole household's, newest first: each
 * with its kind (shared/transactionKinds.ts) and the transfer between your
 * accounts it's one side of, filtered by dates and a search.
 */
import { and, count, desc, eq, gte, inArray, lte, max, min, or, sql } from 'drizzle-orm';
import { fullDescription } from '../../shared/descriptions';
import type { Currency } from '../../shared/money';
import { kindOf } from '../../shared/transactionKinds';
import type { TransactionEntry, TransactionsResponse } from '../../shared/types';
import { inChunks } from '../db/batch';
import { accounts, securities, transactions as transactionsTable, transfers } from '../db/schema';
import { counted } from './importedRecord';
import type { Tenant } from '../db/tenant';
import { isCashSecurity } from './valuation';

/** Transactions returned at most (newest first). */
export const TRANSACTIONS_LIMIT = 2000;

export interface TransactionQuery {
  from?: string;
  to?: string;
  q?: string;
}

/** `account`: one account's; null, every visible account's. */
export async function listTransactions(tenant: Tenant, account: typeof accounts.$inferSelect | null, query: TransactionQuery): Promise<TransactionsResponse> {
  const kind: TransactionsResponse['kind'] = !account ? 'all' : account.type === 'investment' ? 'investment' : 'bank';
  // The account's record: an import's on its days, the institution's on the rest (./importedRecord).
  const all = account ? tenant.scope(transactionsTable, eq(transactionsTable.accountId, account.id), counted()) : tenant.scope(transactionsTable, eq(accounts.isHidden, false), counted());
  // Filters: dates from and to (inclusive), and words in the description or memo, or an amount (either way).
  const day = (value: string | undefined) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);
  const from = day(query.from);
  const to = day(query.to);
  const words = query.q?.trim().slice(0, 100) ?? '';
  const pattern = `%${words.replace(/[%_\\]/g, (found) => `\\${found}`)}%`;
  const like = (column: typeof transactionsTable.description | typeof transactionsTable.memo) => sql`${column} like ${pattern} escape '\\'`;
  const searchedAmount = /^[-$\d.,\s]+$/.test(words) && /\d/.test(words) ? Math.round(Math.abs(Number(words.replace(/[^\d.]/g, ''))) * 100) : null;
  const scope = and(
    all,
    from ? gte(transactionsTable.date, from) : undefined,
    to ? lte(transactionsTable.date, to) : undefined,
    words
      ? searchedAmount !== null && Number.isFinite(searchedAmount)
        ? or(eq(transactionsTable.amount, searchedAmount), eq(transactionsTable.amount, -searchedAmount))
        : or(like(transactionsTable.description), like(transactionsTable.memo))
      : undefined,
  );
  const rows = await tenant.db
    .select({
      id: transactionsTable.id,
      accountId: transactionsTable.accountId,
      currency: transactionsTable.currency,
      date: transactionsTable.date,
      source: transactionsTable.source,
      type: transactionsTable.type,
      subtype: transactionsTable.subtype,
      kind: transactionsTable.kind,
      description: transactionsTable.description,
      memo: transactionsTable.memo,
      ticker: securities.ticker,
      security: securities.name,
      securityType: securities.type,
      quantity: transactionsTable.quantity,
      price: transactionsTable.price,
      amount: transactionsTable.amount,
    })
    .from(transactionsTable)
    .innerJoin(accounts, eq(accounts.id, transactionsTable.accountId))
    .leftJoin(securities, eq(securities.id, transactionsTable.securityId))
    .where(scope)
    .orderBy(desc(transactionsTable.date), desc(transactionsTable.id))
    .limit(TRANSACTIONS_LIMIT);
  // Each one's transfer between your accounts: the other side's account and date.
  const ids = rows.map((row) => row.id);
  const links: { id: string; status: 'auto' | 'confirmed'; outId: string; inId: string }[] = [];
  // Each id is bound twice (either side), so half a chunk at a time keeps under D1's bound-parameter limit.
  for (const chunk of inChunks(ids, 45)) {
    links.push(
      ...((await tenant.db
        .select({ id: transfers.id, status: transfers.status, outId: transfers.outId, inId: transfers.inId })
        .from(transfers)
        .where(tenant.scope(transfers, inArray(transfers.status, ['auto', 'confirmed']), or(inArray(transfers.outId, chunk), inArray(transfers.inId, chunk))))) as typeof links),
    );
  }
  const otherIds = [...new Set(links.flatMap((link) => [link.outId, link.inId]))];
  const others = new Map<string, { accountId: string; accountName: string; institutionName: string | null; mask: string | null; date: string; description: string | null }>();
  for (const chunk of inChunks(otherIds)) {
    const found = await tenant.db
      .select({ id: transactionsTable.id, accountId: transactionsTable.accountId, accountName: accounts.name, institutionName: accounts.institutionName, mask: accounts.mask, date: transactionsTable.date, description: transactionsTable.description, memo: transactionsTable.memo })
      .from(transactionsTable)
      .innerJoin(accounts, eq(accounts.id, transactionsTable.accountId))
      .where(tenant.scope(transactionsTable, inArray(transactionsTable.id, chunk)));
    // Keyed by its id, kept apart from the details: the transfer's own id is the one Unlink sends.
    for (const { id, memo, ...row } of found) others.set(id, { ...row, description: fullDescription(row.description, memo) });
  }
  const transferOf = (id: string): TransactionEntry['transfer'] => {
    const link = links.find((candidate) => candidate.outId === id || candidate.inId === id);
    const other = link && others.get(link.outId === id ? link.inId : link.outId);
    return link && other ? { id: link.id, status: link.status, ...other } : null;
  };
  const transactions: TransactionEntry[] = rows.map(({ securityType, ...row }) => {
    const automatic = kindOf({ ...row, kind: null }, row.security !== null && isCashSecurity({ ticker: row.ticker, type: securityType }));
    return { ...row, currency: row.currency as Currency, kind: row.kind ?? automatic, kindByYou: row.kind !== null, automatic, transfer: transferOf(row.id) };
  });
  const [range] = await tenant.db
    .select({ from: min(transactionsTable.date), to: max(transactionsTable.date) })
    .from(transactionsTable)
    .innerJoin(accounts, eq(accounts.id, transactionsTable.accountId))
    .where(all);
  const [matched] = await tenant.db.select({ total: count() }).from(transactionsTable).innerJoin(accounts, eq(accounts.id, transactionsTable.accountId)).where(scope);
  return {
    kind,
    currency: (account?.currency ?? 'USD') as Currency,
    from: range?.from ?? null,
    to: range?.to ?? null,
    transactions,
    matched: matched?.total ?? 0,
    truncated: (matched?.total ?? 0) > transactions.length,
  };
}
