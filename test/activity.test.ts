import { desc, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { SyncRunSummary } from '../shared/types';
import * as schema from '../server/db/schema';
import { Tenant } from '../server/db/tenant';
import type { Deps } from '../server/ports';
import { backfillConnection } from '../server/services/backfill';
import { runAtomic } from '../server/db/batch';
import { connectionLease, Lease, LEASE_MS, LeaseLostError, snapshotLease } from '../server/services/lease';
import { snapshotHousehold } from '../server/services/snapshots';
import { statusStatement, syncConnection } from '../server/services/sync';
import { ensureRecentCloses, saveCloses } from '../server/services/pricing';
import { account, closes, fakePlaid, fakePrices, holding, security } from './fakes';
import { client, createHousehold, createTestDeps, flush, TODAY } from './helpers';

function brokerage() {
  return fakePlaid({
    accounts: [account('brk', 'investment', 1500, { subtype: 'brokerage' })],
    securities: [security('s-vti', 'VTI', 'etf', 100), security('s-bnd', 'BND', 'etf', 70)],
    holdings: [holding('brk', 's-vti', 10, 100), holding('brk', 's-bnd', 5, 70)],
  });
}

async function linked(plaid = brokerage(), overrides: Partial<Deps> = {}) {
  const deps = await createTestDeps({ plaid, ...overrides });
  const home = await createHousehold(deps, 'Home', 'me@example.com');
  const api = client(deps, home.cookie);
  await api('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'public-x', kind: 'investments' } });
  await flush(deps);
  const [connection] = await deps.db.select().from(schema.connections);
  const activity = async () => (await api(`/api/connections/${connection.id}/activity`)).body.runs as SyncRunSummary[];
  const sync = async () => {
    await deps.db.update(schema.connections).set({ lastSyncedAt: null });
    await api(`/api/connections/${connection.id}/sync`, { method: 'POST' });
  };
  const byName = async (name: string) =>
    ((await api('/api/accounts')).body.accounts as { id: string; name: string }[]).find((row) => row.name === name)!;
  return { deps, home, api, plaid, connection, activity, sync, byName };
}

describe('sync log', () => {
  it('records the link sync with Plaid request ids, counts and what was added', async () => {
    const { activity } = await linked();
    const runs = await activity();
    const sync = runs.find((run) => run.action === 'sync')!;
    expect(sync).toMatchObject({ trigger: 'link', outcome: 'ok', errorCode: null, truncated: false });
    expect(sync.plaidCalls.map((call) => call.endpoint)).toEqual(['getAccounts', 'getHoldings', 'getInvestmentTransactions']);
    expect(sync.plaidCalls.every((call) => call.requestId?.startsWith('req-'))).toBe(true);
    expect(sync.counts).toMatchObject({ accounts: 1, holdings: 2, transactions: 0 });
    expect(sync.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'account_added', account: 'brk' }),
        expect.objectContaining({ kind: 'balance', account: 'brk', before: null, after: 1500_00 }),
        expect.objectContaining({ kind: 'holding', security: 'VTI', before: null, after: 10 }),
        expect.objectContaining({ kind: 'holding', security: 'BND', before: null, after: 5 }),
      ]),
    );
    // The history load after linking is logged too.
    expect(runs.find((run) => run.action === 'history')).toMatchObject({ trigger: 'link', outcome: 'ok' });
  });

  it('records only what changed on later syncs', async () => {
    const { plaid, activity, sync } = await linked();
    await sync();
    expect((await activity())[0]).toMatchObject({ trigger: 'manual', changes: [] });

    plaid.state.accounts = [account('brk', 'investment', 1700, { subtype: 'brokerage' })];
    plaid.state.holdings = [holding('brk', 's-vti', 12, 100)]; // bought VTI, sold all BND
    await sync();
    const [latest] = await activity();
    expect(latest.changes).toEqual([
      expect.objectContaining({ kind: 'balance', before: 1500_00, after: 1700_00, currency: 'USD' }),
      expect.objectContaining({ kind: 'holding', security: 'VTI', before: 10, after: 12 }),
      expect.objectContaining({ kind: 'holding', security: 'BND', before: 5, after: null }),
    ]);
  });

  it('records failed syncs with the Plaid error code and request id', async () => {
    const { plaid, activity, sync } = await linked();
    plaid.state.failWith = 'ITEM_LOGIN_REQUIRED';
    await sync();
    const [failed] = await activity();
    expect(failed).toMatchObject({ outcome: 'error', errorCode: 'ITEM_LOGIN_REQUIRED' });
    expect(failed.plaidCalls).toEqual([expect.objectContaining({ endpoint: 'getAccounts', error: 'ITEM_LOGIN_REQUIRED' })]);
    expect(failed.plaidCalls[0].requestId).toMatch(/^req-/);
  });

  it('logs bank history collection only once a report is ready', async () => {
    const plaid = fakePlaid({
      accounts: [account('chk', 'depository', 1000)],
      historicalBalances: { chk: [{ date: '2026-10-01', current: 900 }, { date: '2026-10-02', current: 950 }] },
      assetReportReady: false,
    });
    const deps = await createTestDeps({ plaid });
    const home = await createHousehold(deps, 'Home', 'me@example.com');
    const api = client(deps, home.cookie);
    await api('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'account' } });
    await flush(deps);
    const [connection] = await deps.db.select().from(schema.connections);
    const runs = async () => (await api(`/api/connections/${connection.id}/activity`)).body.runs as SyncRunSummary[];

    expect((await runs()).find((run) => run.action === 'history')?.counts).toEqual({ assetReportsRequested: 1 });
    // Just linked, so Sync skips Plaid (cooldown) but checks the report: not ready.
    await api(`/api/connections/${connection.id}/sync`, { method: 'POST' });
    const [checked, cooldown] = await runs();
    expect(checked).toMatchObject({ action: 'balance_history', outcome: 'skipped', note: 'Plaid is still preparing the report.' });
    expect(cooldown).toMatchObject({ action: 'sync', outcome: 'skipped', note: 'Last synced less than 2 minutes ago.' });

    plaid.state.assetReportReady = true;
    await api(`/api/connections/${connection.id}/sync`, { method: 'POST' });
    const [collected] = await runs();
    expect(collected).toMatchObject({ action: 'balance_history', trigger: 'manual', outcome: 'ok', counts: { days: 2 } });
    // Deleting the report at Plaid happens after the balances are stored, and is logged too.
    expect(collected.plaidCalls.map((call) => call.endpoint)).toEqual(['getAssetReport', 'removeAssetReport']);
  });

  it("never shows one household another's log", async () => {
    const { deps, connection } = await linked();
    const other = await createHousehold(deps, 'Other', 'other@example.com');
    const response = await client(deps, other.cookie)(`/api/connections/${connection.id}/activity`);
    expect(response.status).toBe(404);
  });
});

describe('price log', () => {
  it('records provider calls and closes that changed value, and nothing when no fetch was needed', async () => {
    // Tiingo's bulk answer lags a day (the 7th), and its close differs from
    // the one Plaid supplied for that day; the 8th comes from the daily endpoint.
    const prices = fakePrices({ VTI: closes('2026-10-06', 3, 101) }, { VTI: { date: '2026-10-07', close: 99 } });
    const deps = await createTestDeps({ prices });
    await saveCloses(deps, [{ ticker: 'VTI', date: '2026-10-07', close: 98, currency: 'USD', source: 'plaid' }], { replace: false });

    await ensureRecentCloses(deps, ['VTI'], TODAY);
    const [run] = await deps.db.select().from(schema.priceRuns);
    expect(run.kind).toBe('latest');
    expect(run.calls.map((call) => call.endpoint)).toEqual(['latest', 'daily']);
    expect(run.calls[0]).toMatchObject({ provider: 'fake-prices', tickers: ['VTI'], returned: 1 });
    expect(run.changes).toEqual([
      expect.objectContaining({ ticker: 'VTI', date: '2026-10-07', before: 98, beforeSource: 'plaid', after: 99, afterSource: 'tiingo' }),
    ]);
    expect(run.saved).toBe(2);

    // Already up to date: nothing fetched, and the check is logged as skipped.
    await ensureRecentCloses(deps, ['VTI'], TODAY);
    const runs = await deps.db.select().from(schema.priceRuns).orderBy(schema.priceRuns.startedAt);
    expect(runs).toHaveLength(2);
    expect(runs.find((entry) => entry.outcome === 'skipped')).toMatchObject({ calls: [], saved: 0, note: expect.stringContaining('already have a close') });
  });
});

describe('nightly job log', () => {
  it('records each run and prunes entries older than two years', async () => {
    const { runDaily } = await import('../server/services/jobs');
    const { deps, connection } = await linked();
    const old = deps.now().getTime() - 731 * 24 * 3600 * 1000;
    await deps.db.insert(schema.jobRuns).values({ id: 'old', job: 'daily', date: '2024-01-01', startedAt: old, finishedAt: old, households: 1, errors: [] });
    await deps.db.update(schema.syncRuns).set({ startedAt: old }).where(eq(schema.syncRuns.connectionId, connection.id));

    await runDaily(deps);
    const jobs = await deps.db.select().from(schema.jobRuns);
    expect(jobs).toEqual([expect.objectContaining({ job: 'daily', households: 1, errors: [] })]);
    const syncs = await deps.db.select().from(schema.syncRuns);
    expect(syncs.length).toBeGreaterThan(0);
    expect(syncs.every((run) => run.trigger === 'nightly')).toBe(true);
  });
});

/** Pause a Plaid call mid-sync: `entered` resolves when it's reached, `release` lets it continue. */
function pauseAt(plaid: ReturnType<typeof brokerage>, method: 'getAccounts' | 'getHoldings') {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  const original = plaid[method].bind(plaid) as (token: string) => Promise<never>;
  let paused = false;
  (plaid as unknown as Record<string, unknown>)[method] = async (token: string) => {
    if (!paused) {
      paused = true;
      enter();
      await released;
    }
    return original(token);
  };
  return { entered, release };
}

const leaseRow = async (deps: Deps, key: string) => (await deps.db.select().from(schema.leases).where(eq(schema.leases.key, key)))[0];
const latestRuns = async (deps: Deps) => deps.db.select().from(schema.syncRuns).orderBy(desc(sql`rowid`));
const holdLease = (deps: Deps, householdId: string, key: string, until: number) =>
  deps.db.insert(schema.leases).values({ key, householdId, holder: 'someone-else', until }).onConflictDoUpdate({ target: schema.leases.key, set: { holder: 'someone-else', until } });

describe('leases', () => {
  it('lets only the holder renew or release, and a lapsed holder cannot write', async () => {
    const { deps, connection } = await linked();
    const tenant = new Tenant(deps.db, connection.householdId);
    const key = connectionLease(connection.id);
    const first = (await Lease.acquire(deps, tenant, key))!;
    expect(await Lease.acquire(deps, tenant, key)).toBeNull();

    // It lapses and someone else takes over.
    const later = new Date(deps.now().getTime() + LEASE_MS + 1);
    deps.now = () => later;
    const second = (await Lease.acquire(deps, tenant, key))!;
    expect(second.abandoned).toBe(true);
    await expect(first.renew()).rejects.toBeInstanceOf(LeaseLostError);
    await first.forceRelease(); // not its lease any more: no effect
    expect((await leaseRow(deps, key)).holder).not.toBeNull();
    expect(await second.release()).toBe(true);
    expect((await leaseRow(deps, key)).holder).toBeNull();
  });
});

describe('one change at a time per connection, applied atomically', () => {
  it('skips (and logs) a sync while the connection is busy; a webhook leaves a note', async () => {
    const { deps, plaid, connection } = await linked();
    const tenant = new Tenant(deps.db, connection.householdId);
    await holdLease(deps, connection.householdId, connectionLease(connection.id), deps.now().getTime() + 60_000);
    const calls = plaid.state.calls.length;

    expect(await syncConnection(deps, tenant, connection.id, 'nightly')).toMatchObject({ skipped: true });
    expect(plaid.state.calls.length).toBe(calls);
    expect((await latestRuns(deps))[0]).toMatchObject({ outcome: 'skipped', note: expect.stringContaining('busy') });

    await syncConnection(deps, tenant, connection.id, 'webhook');
    expect((await latestRuns(deps))[0].note).toMatch(/will sync again/);
    expect((await leaseRow(deps, connectionLease(connection.id))).noteAt).not.toBeNull();
  });

  it('syncs again when a webhook arrives mid-sync, then releases the lease', async () => {
    const { deps, plaid, connection } = await linked();
    const tenant = new Tenant(deps.db, connection.householdId);
    const pause = pauseAt(plaid, 'getHoldings');
    const syncing = syncConnection(deps, tenant, connection.id, 'nightly');
    await pause.entered;
    const later = new Date(deps.now().getTime() + 5);
    deps.now = () => later;
    expect(await syncConnection(deps, tenant, connection.id, 'webhook')).toMatchObject({ skipped: true });
    const later2 = new Date(later.getTime() + 5);
    deps.now = () => later2;
    pause.release();
    await syncing;

    const syncs = (await latestRuns(deps)).filter((run) => run.action === 'sync');
    expect(syncs.find((run) => run.trigger === 'webhook')).toMatchObject({ outcome: 'skipped' });
    const nightly = syncs.filter((run) => run.trigger === 'nightly');
    expect(nightly).toHaveLength(2);
    expect(nightly[0]).toMatchObject({ outcome: 'ok', note: expect.stringContaining('Synced again') });
    expect(nightly[1]).toMatchObject({ outcome: 'ok', note: null });
    expect(await leaseRow(deps, connectionLease(connection.id))).toMatchObject({ holder: null, noteAt: null });
  });

  it('keeps the note when a sync fails, until a later sync succeeds', async () => {
    const { deps, plaid, connection } = await linked();
    const tenant = new Tenant(deps.db, connection.householdId);
    await Lease.leaveNote(deps, tenant, connectionLease(connection.id));
    const later = new Date(deps.now().getTime() + 5);
    deps.now = () => later;
    const getHoldings = plaid.getHoldings;
    plaid.getHoldings = async () => {
      throw new Error('connection reset');
    };
    await expect(syncConnection(deps, tenant, connection.id, 'nightly')).rejects.toThrow('connection reset');
    expect((await latestRuns(deps))[0]).toMatchObject({ outcome: 'error', errorMessage: 'connection reset' });
    expect(await leaseRow(deps, connectionLease(connection.id))).toMatchObject({ holder: null, noteAt: expect.any(Number) });

    plaid.getHoldings = getHoldings;
    await syncConnection(deps, tenant, connection.id, 'manual');
    expect((await leaseRow(deps, connectionLease(connection.id))).noteAt).toBeNull();
  });

  it('notes when the previous run never finished (its lease expired)', async () => {
    const { deps, connection } = await linked();
    await holdLease(deps, connection.householdId, connectionLease(connection.id), deps.now().getTime() - 1);
    await syncConnection(deps, new Tenant(deps.db, connection.householdId), connection.id, 'nightly');
    expect((await latestRuns(deps))[0]).toMatchObject({ outcome: 'ok', note: "The previous run didn't finish (its lease expired)." });
  });

  it('writes nothing when any part of a sync fails to save, and logs the failure', async () => {
    const { deps, plaid, connection, api } = await linked();
    plaid.state.accounts = [account('brk', 'investment', 1700, { subtype: 'brokerage' })];
    // A holding the database rejects (quantity is required) fails the whole batch.
    plaid.state.holdings = [holding('brk', 's-vti', 12, 100), { ...holding('brk', 's-bnd', 5, 70), quantity: null as never }];
    await expect(syncConnection(deps, new Tenant(deps.db, connection.householdId), connection.id, 'manual')).rejects.toThrow();

    const accounts = (await api('/api/accounts')).body.accounts as { name: string; displayBalance: number }[];
    expect(accounts.find((row) => row.name === 'brk')?.displayBalance).toBe(1500_00); // balance untouched
    expect((await deps.db.select().from(schema.holdings)).map((row) => row.quantity).sort()).toEqual([10, 5].sort());
    expect((await latestRuns(deps))[0]).toMatchObject({ outcome: 'error' });
    expect((await leaseRow(deps, connectionLease(connection.id))).holder).toBeNull();
  });

  it('hiding an account waits for a running sync, which then stores nothing for it', async () => {
    const { deps, plaid, connection, api, byName } = await linked();
    const tenant = new Tenant(deps.db, connection.householdId);
    const brk = await byName('brk');
    const pause = pauseAt(plaid, 'getHoldings');
    const syncing = syncConnection(deps, tenant, connection.id, 'nightly');
    await pause.entered;
    const busy = await api(`/api/accounts/${brk.id}`, { method: 'PATCH', json: { isHidden: true } });
    expect(busy.status).toBe(409);
    expect(busy.body.error).toMatch(/sync is running/);
    pause.release();
    await syncing;

    expect((await api(`/api/accounts/${brk.id}`, { method: 'PATCH', json: { isHidden: true } })).status).toBe(200);
    expect(await deps.db.select().from(schema.holdings).where(eq(schema.holdings.accountId, brk.id))).toHaveLength(0);
    await syncConnection(deps, tenant, connection.id, 'manual');
    const [row] = await deps.db.select().from(schema.accounts).where(eq(schema.accounts.id, brk.id));
    expect(row).toMatchObject({ isHidden: true, balance: null });
    expect(await deps.db.select().from(schema.holdings).where(eq(schema.holdings.accountId, brk.id))).toHaveLength(0);
    expect((await latestRuns(deps)).find((run) => run.action === 'account')?.note).toMatch(/Hid “brk”/);
  });

  it("disconnecting waits for a running sync, which can't bring the connection back", async () => {
    const { deps, plaid, connection, api } = await linked();
    const tenant = new Tenant(deps.db, connection.householdId);
    const pause = pauseAt(plaid, 'getHoldings');
    const syncing = syncConnection(deps, tenant, connection.id, 'webhook');
    await pause.entered;
    expect((await api(`/api/connections/${connection.id}`, { method: 'DELETE' })).status).toBe(409);
    pause.release();
    await syncing;

    expect((await api(`/api/connections/${connection.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await syncConnection(deps, tenant, connection.id, 'webhook')).toMatchObject({ status: 'removed' });
    expect((await deps.db.select().from(schema.connections))[0].status).toBe('removed');
    expect((await latestRuns(deps))[0]).toMatchObject({ action: 'disconnect' });
  });

  it('a problem Plaid reports by webhook mid-sync is not overwritten by that sync', async () => {
    const { deps, plaid, connection } = await linked();
    const tenant = new Tenant(deps.db, connection.householdId);
    const pause = pauseAt(plaid, 'getHoldings');
    const syncing = syncConnection(deps, tenant, connection.id, 'nightly'); // fetched before the problem
    await pause.entered;
    const later = new Date(deps.now().getTime() + 1000);
    deps.now = () => later;
    await runAtomic(deps.db, [statusStatement(tenant, connection.id, { status: 'login_required', errorCode: 'ITEM_LOGIN_REQUIRED' }, later.getTime())]);
    pause.release();
    await syncing;
    expect((await deps.db.select().from(schema.connections))[0]).toMatchObject({ status: 'login_required', errorCode: 'ITEM_LOGIN_REQUIRED' });
  });

  it('a history load while the connection is busy runs when the holder finishes', async () => {
    const { deps, plaid, connection } = await linked();
    const tenant = new Tenant(deps.db, connection.householdId);
    const pause = pauseAt(plaid, 'getHoldings');
    const syncing = syncConnection(deps, tenant, connection.id, 'nightly');
    await pause.entered;
    await backfillConnection(deps, tenant, connection.id, null, 'manual'); // busy: marked due
    expect((await latestRuns(deps))[0]).toMatchObject({ action: 'history', outcome: 'skipped' });
    const later = new Date(deps.now().getTime() + 5);
    deps.now = () => later;
    pause.release();
    await syncing;
    expect((await latestRuns(deps)).find((run) => run.action === 'history' && run.outcome === 'ok')).toBeDefined();
    expect((await deps.db.select().from(schema.connections))[0].historyStaleAt).toBeNull();
  });

  it('rebuilds history when a transaction dated before it arrives later', async () => {
    const { deps, plaid, connection } = await linked();
    const tenant = new Tenant(deps.db, connection.householdId);
    expect((await deps.db.select().from(schema.connections))[0].historyAsOf).toBe(TODAY);
    plaid.state.transactions.push({
      investment_transaction_id: 'late-1',
      account_id: 'brk',
      security_id: 's-vti',
      date: '2026-09-15',
      name: 'Buy VTI (posted late)',
      type: 'buy',
      subtype: 'buy',
      quantity: 1,
      amount: 100,
      price: 100,
      fees: 0,
      iso_currency_code: 'USD',
    } as never);
    // Time moves on between the sync's write and the rebuild starting.
    let tick = deps.now().getTime();
    deps.now = () => new Date((tick += 1));
    await syncConnection(deps, tenant, connection.id, 'nightly');
    const runs = await latestRuns(deps);
    expect(runs.find((run) => run.action === 'sync')).toMatchObject({ counts: expect.objectContaining({ lateTransactions: 1 }) });
    expect(runs.find((run) => run.action === 'history')).toMatchObject({ outcome: 'ok', note: expect.stringContaining('Rebuilt') });
    expect((await deps.db.select().from(schema.connections))[0].historyStaleAt).toBeNull();
  });

  it('two connections meeting the same new security at once share one row', async () => {
    const plaid = brokerage();
    const deps = await createTestDeps({ plaid });
    const home = await createHousehold(deps, 'Home', 'me@example.com');
    const api = client(deps, home.cookie);
    await api('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'a', kind: 'investments' } });
    plaid.state.itemId = 'item-2';
    await api('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'b', kind: 'investments' } });
    await flush(deps);
    const tenant = new Tenant(deps.db, home.householdId);
    const [first, second] = await deps.db.select().from(schema.connections);

    plaid.state.securities.push(security('s-new', 'VXUS', 'etf', 60));
    plaid.state.holdings.push(holding('brk', 's-new', 3, 60));
    await Promise.all([syncConnection(deps, tenant, first.id, 'nightly'), syncConnection(deps, tenant, second.id, 'nightly')]);

    const rows = await deps.db.select().from(schema.securities).where(eq(schema.securities.externalId, 's-new'));
    expect(rows).toHaveLength(1);
    expect(await deps.db.select().from(schema.holdings).where(eq(schema.holdings.securityId, rows[0].id))).toHaveLength(2);
  });

  it('keeps your name for a linked account across syncs', async () => {
    const { deps, connection, api, byName } = await linked();
    const brk = await byName('brk');
    await api(`/api/accounts/${brk.id}`, { method: 'PATCH', json: { name: 'Jared brokerage' } });
    await syncConnection(deps, new Tenant(deps.db, connection.householdId), connection.id, 'manual');
    expect((await byName('Jared brokerage'))?.id).toBe(brk.id);
  });
});

describe('household-wide changes', () => {
  it('runs one snapshot at a time; one asked for meanwhile runs after', async () => {
    const { deps, connection } = await linked();
    const tenant = new Tenant(deps.db, connection.householdId);
    await holdLease(deps, connection.householdId, snapshotLease(connection.householdId), deps.now().getTime() + 60_000);
    expect(await snapshotHousehold(deps, tenant, TODAY)).toMatchObject({ skipped: true });
    expect((await leaseRow(deps, snapshotLease(connection.householdId))).noteAt).not.toBeNull();
  });

  it("refuses a holdings save from an editor opened before someone else's save", async () => {
    const deps = await createTestDeps();
    const home = await createHousehold(deps, 'Home', 'me@example.com');
    const api = client(deps, home.cookie);
    const created = await api('/api/accounts', { method: 'POST', json: { name: 'Super', type: 'investment', currency: 'AUD' } });
    const path = `/api/accounts/${created.body.id}/holdings`;
    const { version } = (await api(path)).body;
    expect((await api(path, { method: 'PUT', json: { holdings: [{ ticker: 'FUND', quantity: 1, price: 2 }], version } })).status).toBe(200);
    const stale = await api(path, { method: 'PUT', json: { holdings: [{ ticker: 'FUND', quantity: 9, price: 2 }], version } });
    expect(stale.status).toBe(409);
    expect((await api(path)).body).toMatchObject({ holdings: [expect.objectContaining({ quantity: 1 })], version: version + 1 });
  });

  it('two people signing in for the first time at once share one household', async () => {
    const deps = await createTestDeps();
    deps.config.devLoginEmails = ['a@example.com', 'b@example.com'];
    const api = client(deps);
    await Promise.all([api('/api/auth/dev?email=a@example.com'), api('/api/auth/dev?email=b@example.com')]);
    expect(await deps.db.select().from(schema.households)).toHaveLength(1);
    expect(await deps.db.select().from(schema.householdMembers)).toHaveLength(2);
  });
});
