/** Plaid Transactions: bank, card and loan transactions from /transactions/sync (made-up values throughout). */
import { and, eq, like } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../server/db/schema';
import { Tenant } from '../server/db/tenant';
import { syncConnection } from '../server/services/sync';
import { addDays } from '../shared/dates';
import { account, bankTxn, fakePlaid, firstBuy, security, signWebhook, type PlaidState } from './fakes';
import { client, createHousehold, createTestDeps, dbStats, flush, settle, TODAY } from './helpers';
import { connectionLease, Lease } from '../server/services/lease';

/** A sync's calls, without collecting the bank history report the link asked for. */
const syncCalls = (calls: string[]) => calls.filter((call) => !call.startsWith('asset_report'));

const groceries = { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES', confidence_level: 'VERY_HIGH' };

/** A bank login (checking, a card, a savings account) whose first sync finds Plaid not ready yet. */
async function setup(pages: PlaidState['bankPages'] = [{ next_cursor: '', transactions_update_status: 'NOT_READY' }]) {
  const plaid = fakePlaid({
    itemId: 'item-bank',
    institutionName: 'Example Bank',
    accounts: [account('chk', 'depository', 1000, { mask: '1234' }), account('card', 'credit', 250, { mask: '5678' }), account('sav', 'depository', 5000, { mask: '9012' })],
    historicalBalances: { chk: [{ date: '2026-10-01', current: 900 }] },
    bankPages: pages,
  });
  const deps = await createTestDeps({ plaid });
  const home = await createHousehold(deps, 'Home', 'me@example.com');
  const api = client(deps, home.cookie);
  expect((await api('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'account' } })).status).toBe(200);
  await flush(deps);
  const tenant = new Tenant(deps.db, home.householdId);
  const connection = async () => (await deps.db.select().from(schema.connections))[0];
  const accountId = async (externalId: string) => (await deps.db.select().from(schema.accounts).where(eq(schema.accounts.externalId, externalId)))[0].id;
  const sync = async () => {
    const result = await syncConnection(deps, tenant, (await connection()).id, 'manual');
    await flush(deps);
    return result;
  };
  const stored = () => deps.db.select().from(schema.transactions).where(eq(schema.transactions.source, 'bank')).orderBy(schema.transactions.externalId);
  const runs = () => deps.db.select().from(schema.syncRuns).where(eq(schema.syncRuns.action, 'sync')).orderBy(schema.syncRuns.startedAt);
  return { deps, plaid, api, tenant, connection, accountId, sync, stored, runs };
}

describe('bank transactions', () => {
  it("the first sync adds Transactions and stores nothing while Plaid isn't ready; the login's balances then refresh", async () => {
    const { plaid, api, connection, stored } = await setup();
    expect(plaid.state.bankCursors).toEqual([null]);
    expect(await connection()).toMatchObject({ bankFeed: 'loading', bankCursor: null });
    expect(await stored()).toEqual([]);
    expect((await api('/api/connections')).body.connections[0]).toMatchObject({ bankFeed: 'loading', refreshesBalances: true });
  });

  it("stores posted transactions with Plaid's category, merchant and full description, leaving out pending ones and hidden accounts", async () => {
    const { plaid, api, connection, accountId, sync, stored, deps } = await setup();
    await api(`/api/accounts/${await accountId('sav')}`, { method: 'PATCH', json: { isHidden: true } });
    plaid.state.bankPages.push({
      added: [
        bankTxn('b1', 'chk', '2026-10-02', 42.5, { name: 'Grocer', original_description: 'EXAMPLE GROCER #123 ANYTOWN', merchant_name: 'Example Grocer', payment_channel: 'in store', authorized_date: '2026-10-01', personal_finance_category: groceries }),
        bankTxn('b2', 'card', '2026-10-03', 20, { name: 'Coffee' }),
        bankTxn('b3', 'chk', '2026-10-04', 10, { pending: true }),
        bankTxn('b4', 'sav', '2026-10-04', -100),
      ],
      next_cursor: 'c1',
      transactions_update_status: 'INITIAL_UPDATE_COMPLETE',
    });
    await sync();
    expect(plaid.state.bankCursors.at(-1)).toBeNull();
    const rows = await stored();
    expect(rows.map((row) => row.externalId)).toEqual(['b1', 'b2']);
    expect(rows[0]).toMatchObject({
      accountId: await accountId('chk'),
      date: '2026-10-02',
      amount: 42_50,
      currency: 'USD',
      description: 'EXAMPLE GROCER #123 ANYTOWN',
      plaidCategory: 'FOOD_AND_DRINK',
      plaidCategoryDetailed: 'FOOD_AND_DRINK_GROCERIES',
      plaidCategoryConfidence: 'VERY_HIGH',
      merchantName: 'Example Grocer',
      paymentChannel: 'in store',
      authorizedDate: '2026-10-01',
    });
    // Plaid's name where it sends no original description.
    expect(rows[1]).toMatchObject({ description: 'Coffee', amount: 20_00 });
    // Still loading the older history: the cursor is kept, the next sync carries on from it.
    expect(await connection()).toMatchObject({ bankFeed: 'loading', bankCursor: 'c1' });
    await sync();
    expect(plaid.state.bankCursors.at(-1)).toBe('c1');
    expect(await connection()).toMatchObject({ bankFeed: 'on' });

    // Days covered: the visible bank and card accounts, from the earliest of Plaid's to today.
    const ranges = await deps.db.select().from(schema.transactionRanges).where(eq(schema.transactionRanges.source, 'bank'));
    expect(ranges.map((range) => [range.accountId, range.from, range.to]).sort()).toEqual(
      [
        [await accountId('chk'), '2026-10-02', TODAY],
        [await accountId('card'), '2026-10-02', TODAY],
      ].sort(),
    );
    const listed = (await api('/api/transactions')).body.transactions as { description: string; plaidCategoryDetailed: string | null; merchant: string | null; source: string; kind: string }[];
    expect(listed.find((row) => row.description === 'EXAMPLE GROCER #123 ANYTOWN')).toMatchObject({ source: 'bank', plaidCategoryDetailed: 'FOOD_AND_DRINK_GROCERIES', merchant: 'Example Grocer', kind: 'withdrawal' });
    // The merchant is searched too.
    expect(((await api('/api/transactions?q=Example%20Grocer')).body.transactions as unknown[]).length).toBe(1);
  });

  it('applies changes and removals, keeping a kind you set', async () => {
    const { plaid, sync, stored, deps } = await setup([{ added: [bankTxn('b1', 'chk', '2026-10-02', 30), bankTxn('b2', 'chk', '2026-10-03', 15)], next_cursor: 'c1' }]);
    await deps.db.update(schema.transactions).set({ kind: 'fee' }).where(eq(schema.transactions.externalId, 'b1'));
    plaid.state.bankPages.push({ modified: [bankTxn('b1', 'chk', '2026-10-02', 35, { name: 'Corrected' })], removed: [{ transaction_id: 'b2', account_id: 'chk' }], next_cursor: 'c2' });
    await sync();
    const rows = await stored();
    expect(rows.map((row) => [row.externalId, row.amount, row.description, row.kind])).toEqual([['b1', 35_00, 'Corrected', 'fee']]);
  });

  it('a pass stops at its page cap, and a job of its own carries on with balances and bank transactions only', async () => {
    const { plaid, sync, stored, runs, connection } = await setup([{ next_cursor: '' }]);
    plaid.state.bankPages.push(...Array.from({ length: 9 }, (_, index) => ({ added: [bankTxn(`b${index}`, 'chk', '2026-10-02', index + 1)], next_cursor: `c${index + 1}`, has_more: index < 8 })));
    const before = plaid.state.calls.length;
    const runsBefore = (await runs()).length;
    await sync();
    // Four pages a pass: the sync's, then two jobs carrying on.
    expect(syncCalls(plaid.state.calls.slice(before))).toEqual(['accounts', ...Array(4).fill('bank_transactions'), 'accounts', ...Array(4).fill('bank_transactions'), 'accounts', 'bank_transactions']);
    expect(await stored()).toHaveLength(9);
    const passes = (await runs()).slice(runsBefore);
    expect(passes).toHaveLength(3);
    expect(passes.slice(1).map((pass) => pass.note)).toEqual(['Carried on fetching bank transactions.', 'Carried on fetching bank transactions.']);
    expect((await connection()).bankCursor).toBe('c9');
  });

  it('a paging loop spanning passes restarts from where it began when the data changes, never from a cursor inside it', async () => {
    const { plaid, sync, stored, connection } = await setup([{ next_cursor: '' }]);
    const page = (index: number, more: boolean) => ({ added: [bankTxn(`b${index}`, 'chk', '2026-10-02', index + 1)], next_cursor: `c${index + 1}`, has_more: more });
    // The sync's pass: four pages of more. Then Plaid's history finishes arriving: the cursor inside the loop is stale, and the loop is read again from the start.
    plaid.state.bankPages.push(page(0, true), page(1, true), page(2, true), page(3, true), 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION', page(0, true), page(1, true), page(2, true), page(3, true), page(4, true), page(5, false));
    const asked = plaid.state.bankCursors.length;
    await sync();
    // The sync from the start (none); its job from the cursor it stopped at, then, refused, from the start again; another job finishes.
    expect(plaid.state.bankCursors.slice(asked)).toEqual([null, 'c1', 'c2', 'c3', 'c4', null, 'c1', 'c2', 'c3', 'c4', 'c5']);
    expect((await stored()).map((row) => row.externalId).sort()).toEqual(['b0', 'b1', 'b2', 'b3', 'b4', 'b5']);
    expect(await connection()).toMatchObject({ bankCursor: 'c6', bankRestartCursor: null, bankFeed: 'on' });
  });

  it('remembers where a paging loop began while it spans passes', async () => {
    const { plaid, deps, tenant, connection } = await setup([{ added: [bankTxn('b0', 'chk', '2026-10-01', 1)], next_cursor: 'c0' }]);
    plaid.state.bankPages.push(...Array.from({ length: 5 }, (_, index) => ({ added: [bankTxn(`b${index + 1}`, 'chk', '2026-10-02', index + 2)], next_cursor: `d${index + 1}`, has_more: index < 4 })));
    await syncConnection(deps, tenant, (await connection()).id, 'manual');
    expect(await connection()).toMatchObject({ bankCursor: 'd4', bankRestartCursor: 'c0' });
  });

  it('carrying on waits while the connection is busy', async () => {
    const { deps, plaid, tenant, connection, stored } = await setup([{ next_cursor: '' }]);
    plaid.state.bankPages.push(...Array.from({ length: 5 }, (_, index) => ({ added: [bankTxn(`b${index}`, 'chk', '2026-10-02', index + 1)], next_cursor: `c${index + 1}`, has_more: index < 4 })));
    await syncConnection(deps, tenant, (await connection()).id, 'manual');
    expect(await stored()).toHaveLength(4);
    // Something else holds the connection when the job runs: it waits, without using an attempt.
    const held = (await Lease.acquire(deps, tenant, connectionLease((await connection()).id)))!;
    await flush(deps);
    const [job] = await deps.db.select().from(schema.jobs).where(like(schema.jobs.id, 'bank-more:%'));
    expect(job).toMatchObject({ status: 'queued', attempts: 0 });
    expect(await stored()).toHaveLength(4);
    await held.forceRelease();
    await settle(deps);
    expect(await stored()).toHaveLength(5);
  });

  it('restarts from the stored cursor when the data changes while paging, twice at most', async () => {
    const { plaid, sync, stored, connection } = await setup([{ added: [bankTxn('b1', 'chk', '2026-10-02', 5)], next_cursor: 'c1' }]);
    plaid.state.bankPages.push({ added: [bankTxn('b2', 'chk', '2026-10-03', 6)], next_cursor: 'c2', has_more: true }, 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION', { added: [bankTxn('b2', 'chk', '2026-10-03', 7)], next_cursor: 'c3' });
    await sync();
    expect(plaid.state.bankCursors.slice(-3)).toEqual(['c1', 'c2', 'c1']);
    expect((await stored()).map((row) => [row.externalId, row.amount])).toEqual([
      ['b1', 5_00],
      ['b2', 7_00],
    ]);
    expect((await connection()).bankCursor).toBe('c3');

    // Changing every time: left for the next sync, the cursor as it was.
    plaid.state.bankPages.push('TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION', 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION', 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION');
    expect((await sync()).status).toBe('ok');
    expect((await connection()).bankCursor).toBe('c3');
  });

  it("marks a login Plaid refuses Transactions for, and the sync goes ahead without asking again", async () => {
    const { plaid, api, sync, connection, runs } = await setup(['PRODUCTS_NOT_SUPPORTED']);
    expect(await connection()).toMatchObject({ bankFeed: 'unsupported', bankFeedError: 'PRODUCTS_NOT_SUPPORTED', status: 'ok' });
    expect((await runs())[0]).toMatchObject({ outcome: 'ok' });
    expect((await runs())[0].note).toContain('PRODUCTS_NOT_SUPPORTED');
    expect((await api('/api/connections')).body.connections[0]).toMatchObject({ bankFeed: 'unsupported', refreshesBalances: false });
    const calls = plaid.state.bankCursors.length;
    expect((await sync()).status).toBe('ok');
    expect(plaid.state.bankCursors.length).toBe(calls);
  });

  it('a login needing consent is marked so, not asked again by a webhook, and Link in update mode then the Sync button tries again', async () => {
    const { deps, plaid, api, connection, tenant } = await setup(['ADDITIONAL_CONSENT_REQUIRED']);
    expect(await connection()).toMatchObject({ bankFeed: 'consent', status: 'ok' });
    expect((await api('/api/connections')).body.connections[0]).toMatchObject({ bankFeed: 'consent', refreshesBalances: false });
    const asked = plaid.state.bankCursors.length;
    await syncConnection(deps, tenant, (await connection()).id, 'webhook', { investments: 'none' });
    expect(plaid.state.bankCursors.length).toBe(asked);
    // Update-mode Link (asking for Transactions too), then the resync it ends with, after the cooldown.
    await api('/api/plaid/link-token', { method: 'POST', json: { kind: 'account', connectionId: (await connection()).id } });
    expect(plaid.state.calls).toContain('link:account:update');
    const later = deps.now().getTime() + 10 * 60_000;
    deps.now = () => new Date(later);
    expect((await api(`/api/connections/${(await connection()).id}/sync`, { method: 'POST' })).status).toBe(200);
    expect(await connection()).toMatchObject({ bankFeed: 'on', bankFeedError: null });
  });

  it("un-hiding an account reads the login's bank transactions from the start", async () => {
    const { api, accountId, connection, sync, plaid, stored } = await setup([{ added: [bankTxn('b1', 'chk', '2026-10-02', 5), bankTxn('b2', 'sav', '2026-10-02', 8)], next_cursor: 'c1' }]);
    const sav = await accountId('sav');
    await api(`/api/accounts/${sav}`, { method: 'PATCH', json: { isHidden: true } });
    expect((await stored()).map((row) => row.externalId)).toEqual(['b1']);
    await api(`/api/accounts/${sav}`, { method: 'PATCH', json: { isHidden: false } });
    expect((await connection()).bankCursor).toBeNull();
    plaid.state.bankPages.push({ added: [bankTxn('b1', 'chk', '2026-10-02', 5), bankTxn('b2', 'sav', '2026-10-02', 8)], next_cursor: 'c2' });
    await sync();
    expect(plaid.state.bankCursors.at(-1)).toBeNull();
    expect((await stored()).map((row) => row.externalId)).toEqual(['b1', 'b2']);
  });

  it("Plaid's SYNC_UPDATES_AVAILABLE webhook syncs balances and bank transactions, without investment calls", async () => {
    const { deps, plaid, stored } = await setup([{ next_cursor: 'c0' }]);
    plaid.state.bankPages.push({ added: [bankTxn('b1', 'chk', '2026-10-05', 12)], next_cursor: 'c1' });
    const before = plaid.state.calls.length;
    const body = JSON.stringify({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'item-bank' });
    const response = await client(deps)('/api/plaid/webhook', { method: 'POST', body, headers: { 'plaid-verification': await signWebhook(body, deps.now()), 'content-type': 'application/json', origin: 'https://plaid.com' } });
    expect(response.status).toBe(200);
    await flush(deps);
    expect(syncCalls(plaid.state.calls.slice(before))).toEqual(['accounts', 'bank_transactions']);
    expect((await stored()).map((row) => row.externalId)).toEqual(['b1']);
    const jobs = await deps.db.select().from(schema.jobs).where(and(eq(schema.jobs.type, 'sync')));
    expect(jobs.map((job) => job.payload)).toContainEqual(expect.objectContaining({ trigger: 'webhook', investments: 'none' }));
  });

  it("keeps a full pass well inside D1's 1,000 queries per invocation, beside a login's investment transactions", async () => {
    const pages = Array.from({ length: 4 }, (_, page) => ({
      added: Array.from({ length: 250 }, (_, index) => bankTxn(`b${page}-${index}`, index % 2 ? 'chk' : 'card', addDays('2025-01-01', (page * 250 + index) % 600), 10 + index)),
      next_cursor: `c${page + 1}`,
      has_more: true,
    }));
    const { deps, plaid, tenant, connection, stored } = await setup([{ next_cursor: '' }]);
    plaid.state.accounts.push(account('brk', 'investment', 10_000));
    plaid.state.securities = [security('s-vti', 'VTI', 'etf', 100)];
    plaid.state.transactions = Array.from({ length: 500 }, (_, index) => ({ ...firstBuy('brk', 's-vti'), investment_transaction_id: `i${index}`, date: addDays('2025-01-01', index) }));
    plaid.state.transactionsPageSize = 500;
    await deps.db.update(schema.connections).set({ hasInvestments: true });
    plaid.state.bankPages.push(...pages);
    const before = dbStats(deps).statements;
    await syncConnection(deps, tenant, (await connection()).id, 'manual');
    const statements = dbStats(deps).statements - before;
    expect(await stored()).toHaveLength(1000);
    // About 420: the investment transactions' inserts (every sync sends them all again), the bank's, and the rest of the pass.
    expect(statements).toBeLessThan(500);
  });
});
