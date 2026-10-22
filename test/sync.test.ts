import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../server/db/schema';
import { Tenant } from '../server/db/tenant';
import type { Deps } from '../server/ports';
import { collectPendingReport } from '../server/services/assetReports';
import { connectionLease, Lease } from '../server/services/lease';
import { queueHistory } from '../server/services/backfill';
import { saveCloses } from '../server/services/pricing';
import { snapshotHousehold } from '../server/services/snapshots';
import { syncConnection } from '../server/services/sync';
import { runJob } from '../server/services/jobHandlers';
import { marketDate } from '../shared/dates';
import { account, closes, fakePlaid, fakePrices, holding, security } from './fakes';
import { client, createHousehold, createTestDeps, flush, nightly, TODAY } from './helpers';

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

    // The price provider doesn't know VTI yet, so Plaid's close isn't shared.
    const plaidCloses = await deps.db.select().from(schema.pricesDaily).where(eq(schema.pricesDaily.source, 'plaid'));
    expect(plaidCloses).toEqual([]);

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
    expect((await api('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'x', kind: 'account' } })).status).toBe(503);
  });

  it('creates link tokens, including update mode for an existing connection', async () => {
    const { api, plaid, connection } = await linked();
    expect((await api('/api/plaid/link-token', { method: 'POST', json: { kind: 'account' } })).body.linkToken).toBe('link-sandbox-token');
    await api('/api/plaid/link-token', { method: 'POST', json: { kind: 'investments', connectionId: connection.id } });
    expect(plaid.state.calls).toContain('link:account:new');
    expect(plaid.state.calls).toContain('link:investments:update');
    expect((await api('/api/plaid/link-token', { method: 'POST', json: { kind: 'investments', connectionId: 'nope' } })).status).toBe(404);
    expect((await api('/api/plaid/link-token', { method: 'POST', json: { kind: 'stocks' } })).status).toBe(400);
  });

  it('sends the OAuth redirect address over HTTPS only (phones return there from a bank\'s login)', async () => {
    const { deps, home, plaid } = await linked();
    await client(deps, home.cookie)('/api/plaid/link-token', { method: 'POST', json: { kind: 'account' } });
    const token = home.cookie.split('=')[1];
    const https = client(deps, `__Host-wt_session=${token}`, 'https://wattle.example');
    expect((await https('/api/plaid/link-token', { method: 'POST', json: { kind: 'account' } })).status).toBe(200);
    expect(plaid.state.linkRedirects).toEqual([undefined, 'https://wattle.example/plaid-oauth']);
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

describe('market pricing', () => {
  it('prices stocks and ETFs from market data even without a close from Plaid, but not private funds', async () => {
    const plaid = fakePlaid({
      accounts: [account('k', 'investment', 1000, { subtype: '401k' })],
      securities: [
        security('s-stock', 'SBSI', 'equity', null),
        security('s-etf', 'EWZ', 'etf', null),
        security('s-fund', 'PLANFUND', 'mutual fund', null), // a 401(k) trust
        security('s-listed-fund', 'VTSAX', 'mutual fund', 150), // Plaid gave a close
        security('s-cash', 'CUR:USD', 'cash', 1),
      ],
      holdings: [holding('k', 's-stock', 1, 34), holding('k', 's-etf', 1, 41), holding('k', 's-fund', 1, 20), holding('k', 's-listed-fund', 1, 150)],
    });
    const { deps } = await linked(plaid);
    const rows = await deps.db.select({ ticker: schema.securities.ticker, isPublic: schema.securities.isPublic, lastPrice: schema.securities.lastPrice }).from(schema.securities);
    const byTicker = new Map(rows.map((row) => [row.ticker, row]));
    expect(byTicker.get('SBSI')?.isPublic).toBe(true);
    expect(byTicker.get('EWZ')?.isPublic).toBe(true);
    expect(byTicker.get('PLANFUND')?.isPublic).toBe(false);
    expect(byTicker.get('VTSAX')?.isPublic).toBe(true);
    expect(byTicker.get('CUR:USD')?.isPublic).toBe(false);
    // Without a close from Plaid, the institution's price is kept as the fallback.
    expect(byTicker.get('SBSI')?.lastPrice).toBe(34);
  });

  it("never puts an institution's prices in the shared price table; the household still sees them", async () => {
    const deps = await createTestDeps();
    await saveCloses(deps, [{ ticker: 'VTI', date: '2026-10-07', close: 100, currency: 'USD', source: 'tiingo' }], { replace: true });
    const plaid = fakePlaid({
      accounts: [account('brk', 'investment', 1000)],
      securities: [security('s-vti', 'VTI', 'etf', 101), security('s-own', 'MYPLAN', 'equity', 10)],
      holdings: [holding('brk', 's-vti', 1, 101), holding('brk', 's-own', 1, 10)],
    });
    const { api } = await linked(plaid, { db: deps.db });
    expect(await deps.db.select().from(schema.pricesDaily).where(eq(schema.pricesDaily.source, 'plaid'))).toEqual([]);

    // Plaid's close (2026-10-08) is newer than the shared one, so it's shown.
    const closes = (await api('/api/quotes')).body.closes as { ticker: string; close: number }[];
    expect(Object.fromEntries(closes.map((row) => [row.ticker, row.close]))).toEqual({ VTI: 101, MYPLAN: 10 });

    // Another household holding VTI sees only the shared close.
    const other = await createHousehold(deps, 'Other', 'other@example.com');
    const asOther = client(deps, other.cookie);
    const created = await asOther('/api/accounts', { method: 'POST', json: { name: 'Brokerage', type: 'investment', currency: 'USD' } });
    expect((await asOther(`/api/accounts/${created.body.id}/holdings`, { method: 'PUT', json: { holdings: [{ ticker: 'VTI', quantity: 1 }], version: 0 } })).status).toBe(200);
    expect((await asOther('/api/quotes')).body.closes).toEqual([expect.objectContaining({ ticker: 'VTI', close: 100 })]);
  });
});

describe('security identifiers', () => {
  it("keeps a bond's CUSIP and ISIN when the institution sends them", async () => {
    const plaid = brokerage();
    plaid.state.securities.push({ ...security('s-bill', null, 'fixed income', null, 'United States Treas Bills 0.000% 10/31/24'), cusip: '912797GZ4', isin: 'US912797GZ43' } as never);
    plaid.state.holdings.push(holding('brk', 's-bill', 10, 94.8));
    const { api } = await linked(plaid);
    const bill = (await api('/api/portfolio')).body.holdings.find((row: { type: string }) => row.type === 'fixed income');
    expect(bill).toMatchObject({ ticker: null, cusip: '912797GZ4', isin: 'US912797GZ43' });
  });
});

describe('cash positions', () => {
  it('show their ISO currency code and name, whatever the institution calls them', async () => {
    const plaid = brokerage();
    plaid.state.securities = [
      security('s-vti', 'VTI', 'etf', 100),
      security('s-cash', null, 'cash', 1, 'U S Dollar'), // no ticker: the holding's currency
      security('s-eur', 'CUR:EUR', 'cash', 1, 'EURO CURRENCY'), // Plaid's currency ticker wins
    ];
    plaid.state.holdings = [...plaid.state.holdings, holding('brk', 's-eur', 50, 1)];
    const { api } = await linked(plaid);
    const cash = (await api('/api/portfolio')).body.holdings.filter((row: { type: string }) => row.type === 'cash');
    expect(cash).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ticker: 'USD', name: 'US Dollar (cash)' }),
        expect.objectContaining({ ticker: 'EUR', name: 'Euro (cash)' }),
      ]),
    );
    const { currencyName } = await import('../shared/money');
    expect([currencyName('AUD'), currencyName('JPY'), currencyName('XYZ')]).toEqual(['Australian Dollar', 'Japanese Yen', 'XYZ']);
  });
});

describe('disconnecting', () => {
  it('keeps accounts as manual ones, and the Plaid login so it can be reconnected', async () => {
    const { deps, api, plaid, connection, tenant } = await linked();
    const before = await deps.db.select().from(schema.accounts);
    expect((await api(`/api/connections/${connection.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(plaid.state.removed).toEqual([]); // not removed at Plaid
    const accounts = await deps.db.select().from(schema.accounts);
    expect(accounts.every((row) => row.source === 'manual' && row.connectionId === connection.id)).toBe(true);
    const [kept] = await deps.db.select().from(schema.connections);
    expect(kept.status).toBe('disconnected');
    expect(kept.accessTokenEnc).not.toBe('');
    expect((await api('/api/connections')).body).toMatchObject({ connections: [{ id: connection.id, status: 'disconnected' }], itemsUsed: 1 });
    // Not synced meanwhile.
    expect(await syncConnection(deps, tenant, connection.id, 'nightly')).toMatchObject({ status: 'disconnected', accounts: 0 });

    // While disconnected it's a manual account: a recorded balance is kept after reconnecting.
    const id = before[0].id;
    expect((await api(`/api/accounts/${id}/balances`, { method: 'POST', json: { date: '2026-09-15', balance: 42 } })).status).toBe(200);

    expect((await api(`/api/connections/${connection.id}/reconnect`, { method: 'POST' })).status).toBe(200);
    expect((await deps.db.select().from(schema.connections))[0].status).toBe('ok');
    const after = await deps.db.select().from(schema.accounts);
    expect(after.map((row) => [row.id, row.source]).sort()).toEqual(before.map((row) => [row.id, 'plaid']).sort()); // same accounts, linked again
    const [recorded] = await deps.db
      .select()
      .from(schema.accountDaily)
      .where(and(eq(schema.accountDaily.accountId, id), eq(schema.accountDaily.date, '2026-09-15')));
    expect(recorded).toMatchObject({ balance: 42_00, source: 'manual' });
    expect((await api(`/api/connections/${connection.id}/reconnect`, { method: 'POST' })).status).toBe(409); // already connected
  });

  it('removes the login at Plaid only when PLAID_ALLOW_REMOVE is on', async () => {
    const { deps, api, plaid, connection } = await linked();
    deps.config.plaidAllowRemove = true;
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
  it("carries a linked account's first balance back as an estimate, but not a manual account's", async () => {
    const plaid = brokerage();
    // A mortgage at an investment login: no history before today's snapshot.
    plaid.state.accounts.push(account('mtg', 'loan', 200000));
    const { api } = await linked(plaid);
    await api('/api/accounts', { method: 'POST', json: { name: 'House', type: 'property', currency: 'USD', balance: 500000 } });

    const history = (await api('/api/history?range=1M&group=account&currency=USD')).body;
    const series = (label: string) => history.series.find((row: { label: string }) => row.label === label).values as (number | null)[];
    const yesterday = history.dates.length - 2;
    expect(series('mtg')[0]).toBe(-200000_00); // carried back from today
    expect(series('mtg')[yesterday]).toBe(-200000_00);
    expect(series('House')[0]).toBeNull(); // manual: starts on its entry date
    expect(history.estimated[0]).toBe(true);
    expect(history.estimated.at(-1)).toBe(false); // today is reported
  });

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
    await client(deps, home.cookie)('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'account' } });
    await flush(deps);
    const tenant = new Tenant(deps.db, home.householdId);
    const [connection] = await deps.db.select().from(schema.connections);
    expect(connection.assetReportId).toBe('ar-1');
    expect(connection.assetReportTokenEnc).not.toContain('assets-sandbox');

    const lease = (await Lease.acquire(deps, tenant, connectionLease(connection.id)))!;
    expect(await collectPendingReport(deps, tenant, connection, 'manual', lease)).toBe(false); // not ready yet
    plaid.state.assetReportReady = true;
    expect(await collectPendingReport(deps, tenant, connection, 'manual', lease)).toBe(true);
    await lease.forceRelease();

    const rows = await deps.db.select().from(schema.accountDaily).where(eq(schema.accountDaily.source, 'backfill'));
    expect(rows.map((row) => row.balance).sort((a, b) => a - b)).toEqual([-300_00, 900_00, 950_00]);
    const [after] = await deps.db.select().from(schema.connections);
    expect(after).toMatchObject({ backfillStatus: 'done', assetReportTokenEnc: null });
    expect(plaid.state.calls).toContain('asset_report:remove');
  });

  it('Sync collects a ready asset report whose webhook never arrived, even during the cooldown', async () => {
    const plaid = fakePlaid({
      accounts: [account('chk', 'depository', 1000)],
      historicalBalances: { chk: [{ date: '2026-10-01', current: 900 }] },
      assetReportReady: false,
    });
    const deps = await createTestDeps({ plaid });
    const home = await createHousehold(deps, 'Home', 'me@example.com');
    const api = client(deps, home.cookie);
    await api('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'account' } });
    await flush(deps);
    const [connection] = await deps.db.select().from(schema.connections);

    // Not ready: the report stays pending and nothing else is called.
    const notReady = await api(`/api/connections/${connection.id}/sync`, { method: 'POST' });
    expect(notReady.body.skipped).toBe(true);
    expect((await deps.db.select().from(schema.connections))[0].backfillStatus).not.toBe('done');

    plaid.state.assetReportReady = true;
    await api(`/api/connections/${connection.id}/sync`, { method: 'POST' });
    const [after] = await deps.db.select().from(schema.connections);
    expect(after).toMatchObject({ backfillStatus: 'done', assetReportTokenEnc: null });
    expect(await deps.db.select().from(schema.accountDaily).where(eq(schema.accountDaily.source, 'backfill'))).toHaveLength(1);

    // Nothing pending any more: Sync doesn't ask Plaid for it again.
    const calls = plaid.state.calls.filter((call) => call === 'asset_report:get').length;
    await api(`/api/connections/${connection.id}/sync`, { method: 'POST' });
    expect(plaid.state.calls.filter((call) => call === 'asset_report:get')).toHaveLength(calls);
  });

  it('loads both kinds of history for a login with Investments and Assets', async () => {
    // A brokerage with a cash account, linked once with "Link account".
    const plaid = fakePlaid({
      accounts: [account('brk', 'investment', 1000, { subtype: 'brokerage' }), account('cash', 'depository', 300, { subtype: 'cash management' })],
      securities: [security('s-vti', 'VTI', 'etf', 100)],
      holdings: [holding('brk', 's-vti', 10, 100)],
      historicalBalances: { brk: [{ date: '2026-10-01', current: 1 }], cash: [{ date: '2026-10-01', current: 250 }] },
      itemProducts: ['assets', 'investments'],
      assetReportReady: false,
    });
    const deps = await createTestDeps({ plaid, prices: fakePrices({ VTI: closes('2026-09-20', 30, 100) }) });
    const home = await createHousehold(deps, 'Home', 'me@example.com');
    const api = client(deps, home.cookie);
    await api('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'account' } });
    await flush(deps);
    const accounts = (await api('/api/accounts')).body.accounts as { id: string; name: string; holdingCount: number }[];
    const brk = accounts.find((row) => row.name === 'brk')!;
    const cash = accounts.find((row) => row.name === 'cash')!;
    expect(brk.holdingCount).toBe(1);
    const backfilled = async (accountId: string) =>
      deps.db.select().from(schema.accountDaily).where(and(eq(schema.accountDaily.accountId, accountId), eq(schema.accountDaily.source, 'backfill')));

    // Investments rebuilt straight away; still waiting for the bank's report.
    let [connection] = await deps.db.select().from(schema.connections);
    expect(connection).toMatchObject({ hasInvestments: true, hasBalanceHistory: true, backfillStatus: 'running' });
    expect((await backfilled(brk.id)).length).toBeGreaterThan(1);
    expect(await backfilled(cash.id)).toHaveLength(0);
    expect((await api('/api/connections')).body.connections[0]).toMatchObject({ hasInvestments: true, hasBalanceHistory: true });

    // The report fills in the cash account, not the rebuilt brokerage.
    plaid.state.assetReportReady = true;
    await api(`/api/connections/${connection.id}/sync`, { method: 'POST' });
    [connection] = await deps.db.select().from(schema.connections);
    expect(connection.backfillStatus).toBe('done');
    expect((await backfilled(cash.id)).map((row) => [row.date, row.balance])).toEqual([['2026-10-01', 250_00]]);
    expect((await backfilled(brk.id)).find((row) => row.date === '2026-10-01')?.balance).not.toBe(1_00);
  });

  it("a failed bank report doesn't mark a login's loaded investment history unavailable", async () => {
    const plaid = fakePlaid({
      accounts: [account('brk', 'investment', 1000), account('cash', 'depository', 300)],
      securities: [security('s-vti', 'VTI', 'etf', 100)],
      holdings: [holding('brk', 's-vti', 10, 100)],
      itemProducts: ['assets', 'investments'],
      assetReportGetError: 'ASSET_REPORT_GENERATION_FAILED',
    });
    const deps = await createTestDeps({ plaid, prices: fakePrices({ VTI: closes('2026-09-20', 30, 100) }) });
    const home = await createHousehold(deps, 'Home', 'me@example.com');
    const api = client(deps, home.cookie);
    await api('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'account' } });
    await flush(deps);
    const [connection] = await deps.db.select().from(schema.connections);
    await api(`/api/connections/${connection.id}/sync`, { method: 'POST' });
    const [after] = await deps.db.select().from(schema.connections);
    expect(after).toMatchObject({ backfillStatus: 'done', assetReportTokenEnc: null });
  });

  it('a login linked with Link account but no investment accounts has balance history only', async () => {
    const plaid = fakePlaid({ accounts: [account('chk', 'depository', 1000)], historicalBalances: { chk: [{ date: '2026-10-01', current: 900 }] }, itemProducts: ['assets'] });
    const deps = await createTestDeps({ plaid });
    const home = await createHousehold(deps, 'Home', 'me@example.com');
    await client(deps, home.cookie)('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'account' } });
    await flush(deps);
    const [connection] = await deps.db.select().from(schema.connections);
    expect(connection).toMatchObject({ hasInvestments: false, hasBalanceHistory: true });
    expect(plaid.state.calls).not.toContain('holdings');
  });

  it('skips balance history where the institution does not support Assets', async () => {
    const plaid = fakePlaid({ accounts: [account('chk', 'depository', 1000)], assetReportFails: true });
    const deps = await createTestDeps({ plaid });
    const home = await createHousehold(deps, 'Home', 'me@example.com');
    await client(deps, home.cookie)('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'account' } });
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
    await queueHistory(deps, tenant, connection.id, 'load', 'manual');
    await flush(deps);
    const [row] = await deps.db
      .select()
      .from(schema.accountDaily)
      .where(and(eq(schema.accountDaily.accountId, brk.id), eq(schema.accountDaily.date, '2026-09-30')));
    expect(row).toMatchObject({ balance: 1, source: 'import' });
  });
});

/** Moves the clock to night n after linking (the nightly job runs at 02:00 UTC: market day TODAY + n). */
function nights(deps: Deps) {
  const start = deps.now().getTime();
  return (n: number) => {
    deps.now = () => new Date(start + n * 86400_000);
  };
}

/**
 * What the nightly job does for one login: sync (a failure is logged), run
 * the work it queued (missed days), then snapshot the day.
 */
async function nightlyRun(deps: Deps, tenant: Tenant, connectionId: string) {
  await syncConnection(deps, tenant, connectionId, 'nightly').catch(() => {});
  await flush(deps);
  await snapshotHousehold(deps, tenant, new Date(deps.now().getTime() - 5 * 3600_000).toISOString().slice(0, 10));
}

describe('missed days', () => {
  /** A bank-only login, linked on TODAY (2026-10-08) with its history loaded. */
  async function bank() {
    const plaid = fakePlaid({ accounts: [account('chk', 'depository', 1000)], itemProducts: ['assets'], historicalBalances: { chk: [{ date: '2026-10-07', current: 900 }] } });
    const deps = await createTestDeps({ plaid });
    const home = await createHousehold(deps, 'Home', 'me@example.com');
    const api = client(deps, home.cookie);
    await api('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'account' } });
    await flush(deps);
    const tenant = new Tenant(deps.db, home.householdId);
    const [connection] = await deps.db.select().from(schema.connections);
    await syncConnection(deps, tenant, connection.id, 'manual'); // collects the first report
    const [chk] = await deps.db.select().from(schema.accounts);
    const day = async (date: string) =>
      (await deps.db.select().from(schema.accountDaily).where(and(eq(schema.accountDaily.accountId, chk.id), eq(schema.accountDaily.date, date))))[0];
    const working = plaid.getAccounts;
    const failing = (down: boolean) => {
      plaid.getAccounts = down
        ? async () => {
            throw new Error('network down');
          }
        : working;
    };
    return { deps, plaid, api, tenant, connection, chk, night: nights(deps), day, nightly: () => nightlyRun(deps, tenant, connection.id), failing };
  }

  it("a linked account's reported balance replaces one imported for that day", async () => {
    const { api, chk, night, day, nightly } = await bank();
    night(1);
    await api('/api/imports/balances', { method: 'POST', json: { accountId: chk.id, rows: [{ date: '2026-10-09', balance: 5 }] } });
    expect(await day('2026-10-09')).toMatchObject({ balance: 5_00, source: 'import' });
    await nightly();
    expect(await day('2026-10-09')).toMatchObject({ balance: 1000_00, source: 'sync', estimated: false });
  });

  it('asks the bank for the days after the last one it reported, filling only balances carried forward', async () => {
    const { deps, plaid, api, connection, chk, night, day, nightly, failing } = await bank();
    failing(true);
    night(1);
    await nightly();
    night(2);
    await nightly();
    // Carried forward, and marked as an estimate.
    expect(await day('2026-10-09')).toMatchObject({ balance: 1000_00, source: 'sync', estimated: true });
    // An import replaces an estimate.
    await api('/api/imports/balances', { method: 'POST', json: { accountId: chk.id, rows: [{ date: '2026-10-10', balance: 1150 }] } });

    failing(false);
    plaid.state.accounts = [account('chk', 'depository', 1300)];
    plaid.state.historicalBalances = {
      chk: [
        { date: '2026-10-09', current: 1100 },
        { date: '2026-10-10', current: 1200 },
      ],
    };
    night(3);
    await nightly(); // syncs, then asks for the missed days
    expect(plaid.state.assetReportDays.at(-1)).toBe(3); // the 9th (after the last reported day) to the 11th
    const [asked] = await deps.db.select().from(schema.connections);
    expect(asked.backfillStatus).toBe('done');
    expect(asked.assetReportTokenEnc).not.toBeNull();

    await syncConnection(deps, new Tenant(deps.db, connection.householdId), connection.id, 'manual'); // collects it
    expect(await day('2026-10-08')).toMatchObject({ balance: 1000_00, source: 'sync' }); // reported that day: kept
    expect(await day('2026-10-09')).toMatchObject({ balance: 1100_00, source: 'backfill', estimated: false });
    expect(await day('2026-10-10')).toMatchObject({ balance: 1150_00, source: 'import' }); // yours: kept
    const [after] = await deps.db.select().from(schema.connections);
    expect(after).toMatchObject({ backfillStatus: 'done', assetReportTokenEnc: null });
  });

  it("asks once per gap: days the bank can't fill stay estimated", async () => {
    const { deps, plaid, tenant, connection, night, day, nightly, failing } = await bank();
    failing(true);
    night(1);
    await nightly();
    failing(false);
    plaid.state.historicalBalances = { chk: [] }; // the bank has nothing for those days
    night(2);
    // Syncs with no snapshot between them (e.g. Sync pressed before the nightly
    // snapshot): the gap is still the latest days each time.
    await syncConnection(deps, tenant, connection.id, 'manual');
    await flush(deps); // asks
    const asked = plaid.state.assetReportDays.length;
    await syncConnection(deps, tenant, connection.id, 'manual'); // collects the empty report
    await flush(deps);
    await syncConnection(deps, tenant, connection.id, 'manual');
    await flush(deps);
    expect(plaid.state.assetReportDays).toHaveLength(asked);
    expect(await day('2026-10-09')).toMatchObject({ balance: 1000_00, source: 'backfill', estimated: true }); // asked: still an estimate
  });

  it("doesn't ask when every night synced", async () => {
    const { plaid, night, nightly } = await bank();
    const asked = plaid.state.assetReportDays.length;
    night(1);
    await nightly();
    night(2);
    await nightly();
    expect(plaid.state.assetReportDays).toHaveLength(asked);
  });

  it('rebuilds investment accounts for the missed days from the transactions that arrived after', async () => {
    const prices = fakePrices({ VTI: closes('2024-10-01', 760, 50, 0.1) });
    const { deps, plaid, tenant, connection, byName } = await linked(brokerage(), { prices });
    const night = nights(deps);
    const brk = byName('brk');
    const vti = async (date: string) =>
      (
        await deps.db
          .select()
          .from(schema.holdingDaily)
          .where(and(eq(schema.holdingDaily.accountId, brk.id), eq(schema.holdingDaily.securityId, (await deps.db.select().from(schema.securities).where(eq(schema.securities.ticker, 'VTI')))[0].id), eq(schema.holdingDaily.date, date)))
      )[0];
    const working = plaid.getHoldings;
    plaid.getHoldings = async () => {
      throw new Error('network down');
    };
    night(1);
    await nightlyRun(deps, tenant, connection.id);
    night(2);
    await nightlyRun(deps, tenant, connection.id);
    expect(await vti('2026-10-10')).toMatchObject({ quantity: 10, source: 'sync' }); // last known holdings, carried forward

    // Bought 6 more on the 10th, while syncs were failing.
    plaid.getHoldings = working;
    plaid.state.holdings = [holding('brk', 's-vti', 16, 100), holding('brk', 's-cash', 500, 1), holding('joint', 's-vti', 5, 100)];
    plaid.state.transactions.push({ ...plaid.state.transactions[0], investment_transaction_id: 't2', date: '2026-10-10', quantity: 6, amount: 600 });
    night(3);
    await nightlyRun(deps, tenant, connection.id);
    expect(await vti('2026-10-09')).toMatchObject({ quantity: 10, source: 'backfill' });
    expect(await vti('2026-10-10')).toMatchObject({ quantity: 16, source: 'backfill' });
    const [day] = await deps.db
      .select()
      .from(schema.accountDaily)
      .where(and(eq(schema.accountDaily.accountId, brk.id), eq(schema.accountDaily.date, '2026-10-10')));
    expect(day.source).toBe('backfill');
  });
});

describe('runs stopped part-way (a Worker limit, a crash)', () => {
  /**
   * A bank login whose history plan job is stuck asking for the report, as if
   * the Worker had been stopped there (it never returns, and holds the job's
   * lock and the connection's lease until they run out).
   */
  async function stuckBank() {
    const plaid = fakePlaid({ accounts: [account('chk', 'depository', 1000)], itemProducts: ['assets'], historicalBalances: { chk: [] } });
    const working = plaid.createAssetReport;
    const stuck = () => {
      plaid.createAssetReport = async () => {
        plaid.state.calls.push('asset_report:create');
        return new Promise(() => {}); // never returns: no more code runs, like a stopped Worker
      };
    };
    stuck();
    const deps = await createTestDeps({ plaid });
    const home = await createHousehold(deps, 'Home', 'me@example.com');
    const api = client(deps, home.cookie);
    await api('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'account' } });
    const tenant = new Tenant(deps.db, home.householdId);
    const [connection] = await deps.db.select().from(schema.connections);
    const plan = async () => (await deps.db.select().from(schema.jobs).where(eq(schema.jobs.type, 'history_plan')))[0];
    const asked = () => plaid.state.calls.filter((call) => call === 'asset_report:create').length;
    /** Run the plan job again; it gets stuck again unless resumed. */
    const attempt = async (expectedCalls: number) => {
      void runJob(deps, (await plan()).id);
      await expect.poll(asked).toBe(expectedCalls);
    };
    const later = (minutes: number) => {
      const at = deps.now().getTime() + minutes * 60_000;
      deps.now = () => new Date(at);
    };
    const historyRuns = async () =>
      (await deps.db.select().from(schema.syncRuns).where(eq(schema.syncRuns.action, 'history'))).map((run) => ({ outcome: run.outcome, errorCode: run.errorCode }));
    await attempt(1);
    return { deps, plaid, api, tenant, connection, plan, attempt, asked, later, historyRuns, resume: () => (plaid.createAssetReport = working) };
  }

  it('a stopped job runs again once its lock runs out, and its run is logged once', async () => {
    const { deps, plan, later, historyRuns, resume } = await stuckBank();
    expect(await plan()).toMatchObject({ status: 'running', attempts: 1 });
    expect(await historyRuns()).toEqual([{ outcome: 'running', errorCode: null }]);

    later(3); // its lock (and the connection's lease) runs out
    resume();
    await flush(deps);
    expect(await plan()).toMatchObject({ status: 'done', attempts: 2 });
    expect(await historyRuns()).toEqual([{ outcome: 'ok', errorCode: null }]);
    const [after] = await deps.db.select().from(schema.connections);
    expect(after).toMatchObject({ backfillStatus: 'running' }); // waiting for the report it asked for
    expect(after.assetReportTokenEnc).not.toBeNull();
  });

  it('gives up after three stops: the history is marked failed, shown, and Reload history tries again', async () => {
    const { deps, api, connection, plan, attempt, later, historyRuns, resume } = await stuckBank();
    for (const calls of [2, 3]) {
      later(3);
      await attempt(calls);
    }
    later(3);
    await flush(deps); // a fourth claim finds three attempts stopped: failed as INTERRUPTED
    expect(await plan()).toMatchObject({ status: 'failed', errorCode: 'INTERRUPTED', attempts: 4 });
    expect(await historyRuns()).toEqual([{ outcome: 'error', errorCode: 'INTERRUPTED' }]);
    const [after] = await deps.db.select().from(schema.connections);
    expect(after.backfillStatus).toBe('failed');

    // Shown in the warning banner, to this household only.
    const status = (await api('/api/status')).body;
    expect(status.failedJobs).toEqual([expect.objectContaining({ type: 'history_plan', connectionId: connection.id, institutionName: 'Vanguard', errorCode: 'INTERRUPTED' })]);
    const other = await createHousehold(deps, 'Other', 'other@example.com');
    expect((await client(deps, other.cookie)('/api/status')).body.failedJobs).toEqual([]);

    // Reload history queues a new load.
    resume();
    expect((await api(`/api/connections/${connection.id}/backfill`, { method: 'POST' })).body).toMatchObject({ queued: true });
    await flush(deps);
    expect((await historyRuns()).map((run) => run.outcome)).toEqual(['error', 'ok']);
  });

  it("a stuck history job doesn't hold up the nightly syncs and snapshots", async () => {
    const { deps, connection, plan } = await stuckBank();
    const other = await createHousehold(deps, 'Other', 'other@example.com');
    const created = await client(deps, other.cookie)('/api/accounts', {
      method: 'POST',
      json: { name: 'House', type: 'property', currency: 'USD', balance: 500000, date: '2026-10-01' },
    });
    const run = await nightly(deps); // the stuck plan still holds its lock: not run
    expect(run).toMatchObject({ status: 'ok', households: 2 });
    expect(await plan()).toMatchObject({ status: 'running' });
    const today = marketDate(deps.now());
    const snapshot = async (accountId: string) =>
      (await deps.db.select().from(schema.accountDaily).where(and(eq(schema.accountDaily.accountId, accountId), eq(schema.accountDaily.date, today))))[0];
    const [chk] = await deps.db.select().from(schema.accounts).where(eq(schema.accounts.connectionId, connection.id));
    expect(await snapshot(created.body.id)).toBeTruthy();
    expect(await snapshot(chk.id)).toBeTruthy();
  });

  it('marks a nightly job left running as interrupted, and reports it', async () => {
    const deps = await createTestDeps();
    const home = await createHousehold(deps, 'Home', 'me@example.com');
    const api = client(deps, home.cookie);
    const startedAt = deps.now().getTime() - 25 * 3600_000;
    await deps.db.insert(schema.jobRuns).values({ id: 'j1', job: 'daily', date: '2026-10-07', startedAt, finishedAt: startedAt, status: 'running', households: 0, errors: [] });
    expect((await api('/api/status')).body.nightly).toEqual({ date: '2026-10-07', state: 'interrupted' });

    const run = await nightly(deps);
    expect(run.errors).toContain('The daily job of 2026-10-07 was stopped before finishing.');
    const jobs = await deps.db.select({ date: schema.jobRuns.date, status: schema.jobRuns.status }).from(schema.jobRuns).orderBy(schema.jobRuns.startedAt);
    expect(jobs).toEqual([
      { date: '2026-10-07', status: 'interrupted' },
      { date: '2026-10-08', status: 'errors' },
    ]);
    expect((await api('/api/status')).body.nightly).toEqual({ date: '2026-10-08', state: 'finished' });

    const later = deps.now().getTime() + 27 * 3600_000;
    deps.now = () => new Date(later);
    expect((await api('/api/status')).body.nightly).toEqual({ date: '2026-10-08', state: 'late' });
  });
});
