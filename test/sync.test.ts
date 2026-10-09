import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../server/db/schema';
import { Tenant } from '../server/db/tenant';
import type { Deps } from '../server/ports';
import { backfillConnection, collectBalanceHistory } from '../server/services/backfill';
import { account, closes, fakePlaid, fakePrices, holding, security } from './fakes';
import { client, createHousehold, createTestDeps, flush, TODAY } from './helpers';

/** A brokerage (VTI + cash) and a joint IRA (VTI) at one institution. */
function brokerage() {
  return fakePlaid({
    accounts: [
      account('brk', 'investment', 1500, { mask: '1234', subtype: 'brokerage' }),
      account('joint', 'investment', 500, { mask: '9999', subtype: 'ira' }),
    ],
    securities: [security('s-vti', 'VTI', 'etf', 100), security('s-cash', 'CUR:USD', 'cash', 1, 'US Dollar')],
    holdings: [holding('brk', 's-vti', 10, 100), holding('brk', 's-cash', 500, 1), holding('joint', 's-vti', 5, 100)],
    transactions: [
      {
        investment_transaction_id: 't1',
        account_id: 'brk',
        security_id: 's-vti',
        date: '2026-10-01',
        name: 'Buy VTI',
        type: 'buy',
        subtype: 'buy',
        quantity: 4,
        amount: 400,
        price: 100,
        fees: 0,
        iso_currency_code: 'USD',
      },
    ],
  });
}

async function linked(plaid = brokerage(), overrides: Partial<Deps> = {}) {
  const deps = await createTestDeps({ plaid, ...overrides });
  const home = await createHousehold(deps, 'Home', 'me@example.com');
  const api = client(deps, home.cookie);
  const response = await api('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'public-x', kind: 'investments' } });
  expect(response.status).toBe(200);
  await flush(deps);
  const tenant = new Tenant(deps.db, home.householdId);
  const accounts = (await api('/api/accounts')).body.accounts as { id: string; name: string; mask: string; missingSince: number | null; displayBalance: number | null }[];
  const byName = (name: string) => accounts.find((row) => row.name === name)!;
  const [connection] = await deps.db.select().from(schema.connections);
  return { deps, home, api, tenant, plaid, byName, connection, response };
}

describe('linking', () => {
  it('stores an encrypted token, masks only, accounts, holdings and transactions', async () => {
    const { deps, api, response, connection, byName } = await linked();
    expect(response.body).toMatchObject({ accounts: 2, holdings: 3, transactions: 1, status: 'ok' });
    expect(connection.accessTokenEnc).not.toContain('access-sandbox');
    expect(connection.institutionName).toBe('Vanguard');
    expect(byName('brk').mask).toBe('1234');

    const portfolio = (await api('/api/portfolio?currency=USD')).body;
    expect(portfolio.netWorth).toBe(2000_00);
    expect(portfolio.allCategories.us_stock).toBe(1500_00);
    expect(portfolio.allCategories.cash).toBe(500_00);

    // Securities are classified on arrival from the seeded profiles.
    const [vti] = await deps.db.select().from(schema.securities).where(eq(schema.securities.ticker, 'VTI'));
    expect(vti.classificationSource).toBe('seed');
    expect(vti.isPublic).toBe(true);
  });

  it('re-linking the same login updates the existing connection', async () => {
    const { deps, api } = await linked();
    await api('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'public-y', kind: 'investments' } });
    expect(await deps.db.select().from(schema.connections)).toHaveLength(1);
    expect(await deps.db.select().from(schema.accounts)).toHaveLength(2);
  });

  it('answers 503 when Plaid is not configured', async () => {
    const deps = await createTestDeps();
    const home = await createHousehold(deps, 'Home', 'me@example.com');
    const api = client(deps, home.cookie);
    expect((await api('/api/plaid/link-token', { method: 'POST', json: { kind: 'investments' } })).status).toBe(503);
    expect((await api('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'x', kind: 'banking' } })).status).toBe(503);
  });

  it('creates link tokens, including update mode for an existing connection', async () => {
    const { api, plaid, connection } = await linked();
    expect((await api('/api/plaid/link-token', { method: 'POST', json: { kind: 'banking' } })).body.linkToken).toBe('link-sandbox-token');
    await api('/api/plaid/link-token', { method: 'POST', json: { kind: 'investments', connectionId: connection.id } });
    expect(plaid.state.calls).toContain('link:banking:new');
    expect(plaid.state.calls).toContain('link:investments:update');
    expect((await api('/api/plaid/link-token', { method: 'POST', json: { kind: 'investments', connectionId: 'nope' } })).status).toBe(404);
    expect((await api('/api/plaid/link-token', { method: 'POST', json: { kind: 'stocks' } })).status).toBe(400);
  });
});

describe('ongoing sync', () => {
  it('drops a sold position from holdings and shows it as zero afterwards', async () => {
    const { deps, api, plaid, byName, tenant } = await linked();
    // History for the brokerage: yesterday it still held VTI.
    const { snapshotHousehold } = await import('../server/services/snapshots');
    const yesterday = new Date('2026-10-08T02:00:00Z');
    deps.now = () => yesterday;
    await snapshotHousehold(deps, tenant, '2026-10-07');
    deps.now = () => new Date('2026-10-09T02:00:00Z');

    // Today VTI is sold for cash.
    plaid.state.holdings = [holding('brk', 's-cash', 1500, 1), holding('joint', 's-vti', 5, 100)];
    await deps.db.update(schema.connections).set({ lastSyncedAt: null });
    await api(`/api/connections/${(await deps.db.select().from(schema.connections))[0].id}/sync`, { method: 'POST' });

    const brk = byName('brk');
    const rows = await deps.db.select().from(schema.holdings).where(eq(schema.holdings.accountId, brk.id));
    expect(rows).toHaveLength(1);

    const history = (await api(`/api/history?range=1M&group=holding&accountId=${brk.id}`)).body;
    const vti = history.series.find((series: { label: string }) => series.label === 'VTI');
    const index = (date: string) => history.dates.indexOf(date);
    expect(vti.values[index('2026-10-07')]).toBe(1000_00);
    expect(vti.values[index(TODAY)]).toBe(0);
  });

  it('skips zero-unit positions some institutions keep reporting', async () => {
    const plaid = brokerage();
    plaid.state.holdings.push({ ...holding('brk', 's-cash', 0, 1) });
    plaid.state.holdings = [holding('brk', 's-vti', 0, 100), holding('joint', 's-vti', 5, 100)];
    const { deps } = await linked(plaid);
    expect(await deps.db.select().from(schema.holdings)).toHaveLength(1);
  });

  it('flags accounts the institution stops reporting and leaves them out of totals', async () => {
    const { deps, api, plaid, connection } = await linked();
    plaid.state.accounts = plaid.state.accounts.filter((row) => row.account_id !== 'joint');
    plaid.state.holdings = plaid.state.holdings.filter((row) => row.account_id !== 'joint');
    await deps.db.update(schema.connections).set({ lastSyncedAt: null });
    await api(`/api/connections/${connection.id}/sync`, { method: 'POST' });

    const accounts = (await api('/api/accounts')).body.accounts;
    const joint = accounts.find((row: { name: string }) => row.name === 'joint');
    expect(joint.missingSince).not.toBeNull();
    expect(joint.displayBalance).toBeNull();
    expect((await api('/api/portfolio')).body.netWorth).toBe(1500_00);

    // It comes back if the institution reports it again.
    plaid.state.accounts.push(account('joint', 'investment', 500));
    await deps.db.update(schema.connections).set({ lastSyncedAt: null });
    await api(`/api/connections/${connection.id}/sync`, { method: 'POST' });
    const again = (await api('/api/accounts')).body.accounts.find((row: { name: string }) => row.name === 'joint');
    expect(again.missingSince).toBeNull();
  });

  it('hiding an account stops storing its data', async () => {
    const { deps, api, byName, connection } = await linked();
    const joint = byName('joint');
    expect((await api(`/api/accounts/${joint.id}`, { method: 'PATCH', json: { isHidden: true, purge: true } })).status).toBe(200);
    expect((await api('/api/portfolio')).body.netWorth).toBe(1500_00);

    await deps.db.update(schema.connections).set({ lastSyncedAt: null });
    await api(`/api/connections/${connection.id}/sync`, { method: 'POST' });
    expect(await deps.db.select().from(schema.holdings).where(eq(schema.holdings.accountId, joint.id))).toHaveLength(0);
    expect(await deps.db.select().from(schema.accountDaily).where(eq(schema.accountDaily.accountId, joint.id))).toHaveLength(0);
    const [row] = await deps.db.select().from(schema.accounts).where(eq(schema.accounts.id, joint.id));
    expect(row.balance).toBeNull();
    expect(row.isHidden).toBe(true);
  });

  it('rate-limits manual syncs', async () => {
    const { api, plaid, connection } = await linked();
    const before = plaid.state.calls.length;
    const response = await api(`/api/connections/${connection.id}/sync`, { method: 'POST' });
    expect(response.body.skipped).toBe(true);
    expect(plaid.state.calls.length).toBe(before);
  });

  it('marks a connection that needs re-authentication', async () => {
    const { deps, api, plaid, connection } = await linked();
    plaid.state.failWith = 'ITEM_LOGIN_REQUIRED';
    await deps.db.update(schema.connections).set({ lastSyncedAt: null });
    const response = await api(`/api/connections/${connection.id}/sync`, { method: 'POST' });
    expect(response.body.status).toBe('login_required');
    const listed = (await api('/api/connections')).body.connections[0];
    expect(listed).toMatchObject({ status: 'login_required', errorCode: 'ITEM_LOGIN_REQUIRED' });
  });

  it('tolerates investment history that is not ready yet', async () => {
    const plaid = brokerage();
    plaid.state.transactionsNotReady = true;
    const { response, connection } = await linked(plaid);
    expect(response.body.transactions).toBe(0);
    expect(connection.txnSyncedThrough).toBeNull();
  });

  it('pages through investment transactions', async () => {
    const plaid = brokerage();
    plaid.state.transactions = Array.from({ length: 5 }, (_, index) => ({
      ...plaid.state.transactions[0],
      investment_transaction_id: `t${index}`,
      date: `2026-09-0${index + 1}`,
    }));
    const { deps } = await linked(plaid);
    expect(await deps.db.select().from(schema.investmentTransactions)).toHaveLength(5);
  });
});

describe('disconnecting', () => {
  it('keeps accounts as manual ones by default', async () => {
    const { deps, api, plaid, connection } = await linked();
    expect((await api(`/api/connections/${connection.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(plaid.state.removed).toEqual(['access-sandbox-item-1']);
    const accounts = await deps.db.select().from(schema.accounts);
    expect(accounts.every((row) => row.source === 'manual' && row.connectionId === null)).toBe(true);
    const [removed] = await deps.db.select().from(schema.connections);
    expect(removed).toMatchObject({ status: 'removed', accessTokenEnc: '' });
    expect((await api('/api/connections')).body).toMatchObject({ connections: [], itemsUsed: 1 });
  });

  it('can delete the accounts and their history too', async () => {
    const { deps, api, connection } = await linked();
    await api(`/api/connections/${connection.id}?purge=1`, { method: 'DELETE' });
    expect(await deps.db.select().from(schema.accounts)).toHaveLength(0);
    expect(await deps.db.select().from(schema.holdingDaily)).toHaveLength(0);
  });
});

describe('history backfill', () => {
  it('rebuilds investment history from transactions and daily closes', async () => {
    const prices = fakePrices({ VTI: closes('2024-10-01', 740, 50, 0.1) });
    const { deps, byName } = await linked(brokerage(), { prices });
    const brk = byName('brk');
    const rows = await deps.db
      .select()
      .from(schema.holdingDaily)
      .where(and(eq(schema.holdingDaily.accountId, brk.id), eq(schema.holdingDaily.date, '2026-09-30')));
    const vti = rows.find((row) => row.price !== 1)!;
    expect(vti.quantity).toBe(6); // 10 today, minus the 4 bought on Oct 1
    expect(vti.source).toBe('backfill');
    expect(vti.price).toBeGreaterThan(50);
    const [connection] = await deps.db.select().from(schema.connections);
    expect(connection.backfillStatus).toBe('done');
  });

  it('collects bank balance history from an asset report', async () => {
    const plaid = fakePlaid({
      accounts: [account('chk', 'depository', 1000), account('card', 'credit', 250)],
      historicalBalances: {
        chk: [
          { date: '2026-10-01', current: 900 },
          { date: '2026-10-02', current: 950 },
        ],
        card: [{ date: '2026-10-01', current: 300 }],
      },
      assetReportReady: false,
    });
    const deps = await createTestDeps({ plaid });
    const home = await createHousehold(deps, 'Home', 'me@example.com');
    await client(deps, home.cookie)('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'banking' } });
    await flush(deps);
    const tenant = new Tenant(deps.db, home.householdId);
    const [connection] = await deps.db.select().from(schema.connections);
    expect(connection.assetReportId).toBe('ar-1');
    expect(connection.assetReportTokenEnc).not.toContain('assets-sandbox');

    expect(await collectBalanceHistory(deps, tenant, connection.id)).toBe(false); // not ready yet
    plaid.state.assetReportReady = true;
    expect(await collectBalanceHistory(deps, tenant, connection.id)).toBe(true);

    const rows = await deps.db.select().from(schema.accountDaily).where(eq(schema.accountDaily.source, 'backfill'));
    expect(rows.map((row) => row.balance).sort((a, b) => a - b)).toEqual([-300_00, 900_00, 950_00]);
    const [after] = await deps.db.select().from(schema.connections);
    expect(after).toMatchObject({ backfillStatus: 'done', assetReportTokenEnc: null });
    expect(plaid.state.calls).toContain('asset_report:remove');
  });

  it('skips balance history where the institution does not support Assets', async () => {
    const plaid = fakePlaid({ accounts: [account('chk', 'depository', 1000)], assetReportFails: true });
    const deps = await createTestDeps({ plaid });
    const home = await createHousehold(deps, 'Home', 'me@example.com');
    await client(deps, home.cookie)('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'banking' } });
    await flush(deps);
    const [connection] = await deps.db.select().from(schema.connections);
    expect(connection.backfillStatus).toBe('skipped');
  });

  it('can be re-run on demand and never overwrites synced days', async () => {
    const { deps, api, tenant, connection, byName } = await linked();
    const brk = byName('brk');
    await deps.db
      .insert(schema.accountDaily)
      .values({ householdId: tenant.householdId, accountId: brk.id, date: '2026-09-30', balance: 1, currency: 'USD', source: 'import' })
      .onConflictDoUpdate({ target: [schema.accountDaily.accountId, schema.accountDaily.date], set: { balance: 1, source: 'import' } });
    expect((await api(`/api/connections/${connection.id}/backfill`, { method: 'POST' })).status).toBe(200);
    await flush(deps);
    await backfillConnection(deps, tenant, connection.id, null);
    const [row] = await deps.db
      .select()
      .from(schema.accountDaily)
      .where(and(eq(schema.accountDaily.accountId, brk.id), eq(schema.accountDaily.date, '2026-09-30')));
    expect(row).toMatchObject({ balance: 1, source: 'import' });
  });
});
