/**
 * Plaid Transactions: a login's bank, card, loan and cash management
 * transactions, from /transactions/sync, stored as source `bank` (`plaid`
 * stays Plaid's investment transactions). Fetched on every sync pass: the
 * nightly job, the Sync button, and Plaid's SYNC_UPDATES_AVAILABLE webhook.
 *
 * The sync is cursor-based: with no cursor, all the history Plaid has for
 * the login (the first call adds the product to it and asks for two years),
 * then only what changed since the saved cursor. The history arrives in
 * stages (about 30 days, then the rest), so a login's feed is `loading`
 * until Plaid says it's complete. The new cursor is written in the pass's
 * atomic batch with the transactions it covers: all applied, or neither.
 *
 * Posted transactions only, as bank reports: a pending one's id changes
 * when it posts. Plaid's details (its full description, category, merchant)
 * are kept on its own row; an imported file's transaction it pairs with
 * shows them (./importedRecord).
 */
import { and, eq, inArray, min, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { Transaction } from 'plaid';
import { marketDate } from '../../shared/dates';
import { toMinor } from '../../shared/money';
import { PlaidApiError, type PlaidApi } from '../adapters/plaid';
import { chunkRows, inChunks } from '../db/batch';
import { connections, transactions } from '../db/schema';
import type { Tenant } from '../db/tenant';
import type { Deps } from '../ports';
import type { SyncRun, SyncTrigger } from './activity';
import { rangeStatements } from './coverage';
import type { ConnectionRow, VisibleAccounts } from './sync';

/**
 * Pages fetched a pass at most (250 transactions each). A pass's writes are
 * one batch, and an insert holds 4 transactions (D1's 100 parameters), so
 * 1,000 transactions are about 250 statements, well inside D1's 1,000 queries
 * per invocation beside the pass's other writes. A pass that stops short is
 * carried on by a job of its own (./sync).
 */
export const BANK_PAGES_PER_PASS = 4;

/** Times a sync restarts from the stored cursor when the data changed while it paged, before leaving it for the next one. */
const MUTATION_RETRIES = 2;

/** Plaid refusing the product for the login (or the client): not asked again. */
const UNSUPPORTED = new Set(['PRODUCTS_NOT_SUPPORTED', 'INVALID_PRODUCT', 'NO_ACCOUNTS']);

/** Account types whose transactions come from Plaid Transactions, and whose days it covers. */
const BANK_TYPES = new Set(['depository', 'credit', 'loan']);

/**
 * Whether a pass fetches the login's bank transactions: not where Plaid
 * refused them; where the institution needs them granted, only on the Sync
 * button (which Link's update mode ends with) and the nightly sync, which
 * find out whether they have been since.
 */
export const fetchesBank = (connection: Pick<ConnectionRow, 'bankFeed'>, trigger: SyncTrigger) =>
  connection.bankFeed !== 'unsupported' && (connection.bankFeed !== 'consent' || trigger === 'manual' || trigger === 'nightly');

/** What one pass got from /transactions/sync. */
export type BankFetch =
  /** Changes since the stored cursor: added and modified together (the latest of each), and the ids removed. */
  | {
      outcome: 'changes';
      changed: Transaction[];
      removed: string[];
      cursor: string;
      feed: 'loading' | 'on';
      more: boolean;
      /** With more to come: the cursor this paging loop began from ('' from the start), for a later pass to restart from (bank_restart_cursor); null when the loop is done. */
      restart: string | null;
    }
  /** Plaid has nothing for the login yet. */
  | { outcome: 'loading' }
  | { outcome: 'refused'; feed: 'unsupported' | 'consent'; code: string }
  /** Left for the next sync (the cursor stays). */
  | { outcome: 'skipped'; note: string };

/**
 * Page from the login's stored cursor until Plaid has no more, or
 * BANK_PAGES_PER_PASS. Login problems are thrown, as other calls'.
 *
 * A paging loop can span passes (a pass stops at its page cap), and Plaid's
 * cursors from inside a loop go stale once the login's data changes: on
 * TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION the loop starts again from
 * the cursor it began with (bank_restart_cursor while one spans passes,
 * else the stored cursor), never from one inside it. Pages read again are
 * upserted again, which changes nothing.
 */
export async function fetchBankTransactions(plaid: PlaidApi, accessToken: string, connection: Pick<ConnectionRow, 'bankCursor' | 'bankRestartCursor'>): Promise<BankFetch> {
  // Where this loop began: '' for the very start (no cursor).
  const loopStart = connection.bankRestartCursor ?? connection.bankCursor ?? '';
  for (let attempt = 0; ; attempt++) {
    const changed = new Map<string, Transaction>();
    const removed = new Set<string>();
    let cursor = attempt === 0 ? connection.bankCursor : loopStart || null;
    let more = false;
    let status: string | undefined;
    try {
      for (let page = 0; page < BANK_PAGES_PER_PASS; page++) {
        const result = await plaid.syncTransactions(accessToken, cursor);
        if (!result.next_cursor) return { outcome: 'loading' };
        for (const txn of [...result.added, ...result.modified]) {
          removed.delete(txn.transaction_id);
          changed.set(txn.transaction_id, txn);
        }
        for (const gone of result.removed) {
          changed.delete(gone.transaction_id);
          removed.add(gone.transaction_id);
        }
        cursor = result.next_cursor;
        status = result.transactions_update_status;
        more = result.has_more;
        if (!more) break;
      }
    } catch (error) {
      if (!(error instanceof PlaidApiError)) throw error;
      // The login's data changed while paging: start the loop again from where it began.
      if (error.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') {
        if (attempt < MUTATION_RETRIES) continue;
        return { outcome: 'skipped', note: "Plaid's bank transactions kept changing while they were fetched; left for the next sync." };
      }
      if (error.code === 'PRODUCT_NOT_READY') return { outcome: 'loading' };
      if (UNSUPPORTED.has(error.code)) return { outcome: 'refused', feed: 'unsupported', code: error.code };
      if (error.code === 'ADDITIONAL_CONSENT_REQUIRED') return { outcome: 'refused', feed: 'consent', code: error.code };
      throw error;
    }
    return { outcome: 'changes', changed: [...changed.values()], removed: [...removed], cursor: cursor!, feed: status === 'HISTORICAL_UPDATE_COMPLETE' ? 'on' : 'loading', more, restart: more ? loopStart : null };
  }
}

/**
 * Plan the writes for what was fetched: posted transactions of the login's
 * visible bank, card and loan accounts upserted by Plaid's id (never touching
 * a kind you set or what replaced it), removed ones deleted (transfers on
 * them go too), and the days covered: each such account, from the earliest
 * bank transaction stored for the login to today (as for investments,
 * nothing until Plaid has returned some). Returns the connection's new
 * columns and how many transactions changed.
 */
export async function planBankTransactions(
  deps: Deps,
  tenant: Tenant,
  connection: ConnectionRow,
  fetched: BankFetch,
  visible: VisibleAccounts,
  run: SyncRun,
  writes: BatchItem<'sqlite'>[],
): Promise<{ connection: Partial<typeof connections.$inferInsert>; changed: number }> {
  const addNote = (note: string) => (run.note = [run.note, note].filter(Boolean).join(' '));
  if (fetched.outcome === 'skipped') {
    addNote(fetched.note);
    return { connection: {}, changed: 0 };
  }
  if (fetched.outcome === 'loading') {
    if (connection.bankFeed !== 'loading') addNote('Plaid is still gathering bank transactions.');
    return { connection: { bankFeed: 'loading' }, changed: 0 };
  }
  if (fetched.outcome === 'refused') {
    addNote(
      fetched.feed === 'consent'
        ? `The institution hasn't granted bank transactions (${fetched.code}): sign in again to allow them.`
        : `Plaid doesn't offer bank transactions for this login (${fetched.code}); the rest of the sync goes on.`,
    );
    return { connection: { bankFeed: fetched.feed, bankFeedError: fetched.code }, changed: 0 };
  }

  const now = deps.now().getTime();
  const today = marketDate(deps.now());
  const bankAccounts = new Map([...visible].filter(([, account]) => account.type !== 'investment'));
  const rows = fetched.changed
    .filter((txn) => !txn.pending && bankAccounts.has(txn.account_id))
    .map((txn) => {
      const account = bankAccounts.get(txn.account_id)!;
      const category = txn.personal_finance_category ?? null;
      return {
        id: crypto.randomUUID(),
        householdId: tenant.householdId,
        accountId: account.id,
        source: 'bank' as const,
        externalId: txn.transaction_id,
        date: txn.date,
        // Plaid's sign is already Wattle's: positive when money leaves the account.
        amount: toMinor(txn.amount),
        currency: txn.iso_currency_code ?? txn.unofficial_currency_code ?? account.currency,
        description: txn.original_description ?? txn.name ?? null,
        plaidCategory: category?.primary ?? null,
        plaidCategoryDetailed: category?.detailed ?? null,
        plaidCategoryConfidence: category?.confidence_level ?? null,
        merchantName: txn.merchant_name ?? null,
        paymentChannel: txn.payment_channel ?? null,
        authorizedDate: txn.authorized_date ?? null,
        createdAt: now,
      };
    });
  for (const chunk of chunkRows(transactions, rows)) {
    writes.push(
      tenant.db
        .insert(transactions)
        .values(chunk)
        .onConflictDoUpdate({
          target: [transactions.accountId, transactions.source, transactions.externalId],
          // Plaid's own columns only: a kind you set, and what replaced it, stay.
          set: {
            date: sql`excluded.date`,
            amount: sql`excluded.amount`,
            currency: sql`excluded.currency`,
            description: sql`excluded.description`,
            plaidCategory: sql`excluded.plaid_category`,
            plaidCategoryDetailed: sql`excluded.plaid_category_detailed`,
            plaidCategoryConfidence: sql`excluded.plaid_category_confidence`,
            merchantName: sql`excluded.merchant_name`,
            paymentChannel: sql`excluded.payment_channel`,
            authorizedDate: sql`excluded.authorized_date`,
          },
        }),
    );
  }
  for (const ids of inChunks(fetched.removed)) {
    writes.push(tenant.db.delete(transactions).where(tenant.scope(transactions, eq(transactions.source, 'bank'), inArray(transactions.externalId, ids))));
  }

  // The days Plaid's covers, once it has returned any.
  const covered = [...bankAccounts.values()].filter((account) => BANK_TYPES.has(account.type)).map((account) => account.id);
  let earliest = rows.map((row) => row.date).sort()[0];
  for (const ids of inChunks([...bankAccounts.values()].map((account) => account.id))) {
    const [stored] = await tenant.db
      .select({ first: min(transactions.date) })
      .from(transactions)
      .where(tenant.scope(transactions, and(eq(transactions.source, 'bank'), inArray(transactions.accountId, ids))));
    if (stored?.first && (!earliest || stored.first < earliest)) earliest = stored.first;
  }
  if (earliest) {
    const from = earliest < today ? earliest : today;
    for (const accountId of covered) writes.push(...(await rangeStatements(tenant, accountId, 'bank', from, today, now)));
  }

  run.count('bankTransactions', rows.length);
  if (fetched.removed.length > 0) run.count('bankRemoved', fetched.removed.length);
  if (fetched.feed === 'loading' && connection.bankFeed !== 'loading') addNote('Plaid is still gathering the older bank transactions.');
  return { connection: { bankCursor: fetched.cursor, bankRestartCursor: fetched.restart, bankFeed: fetched.feed, bankFeedError: null }, changed: rows.length + fetched.removed.length };
}
