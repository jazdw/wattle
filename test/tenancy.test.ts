import { describe, expect, it } from 'vitest';
import * as schema from '../server/db/schema';
import { account, fakePlaid, holding, security, signWebhook } from './fakes';
import { client, createHousehold, createTestDeps, flush } from './helpers';

async function setup() {
  const deps = await createTestDeps();
  const a = await createHousehold(deps, 'A', 'a@example.com');
  const b = await createHousehold(deps, 'B', 'b@example.com');
  const asA = client(deps, a.cookie);
  const asB = client(deps, b.cookie);
  const created = await asA('/api/accounts', {
    method: 'POST',
    json: { name: 'House', type: 'property', currency: 'AUD', balance: 900000, date: '2026-10-01' },
  });
  expect(created.status).toBe(201);
  await asA(`/api/accounts/${created.body.id}/holdings`, { method: 'GET' });
  await deps.db.insert(schema.securities).values({
    id: 'sec-a',
    householdId: a.householdId,
    ticker: 'SECRET',
    name: 'Private Plan Trust',
    createdAt: Date.now(),
  });
  return { deps, a, b, asA, asB, accountId: created.body.id as string };
}

describe('tenant isolation', () => {
  it('rejects unauthenticated requests', async () => {
    const deps = await createTestDeps();
    for (const path of ['/api/accounts', '/api/portfolio', '/api/history', '/api/securities', '/api/connections', '/api/auth/me', '/api/quotes', '/api/targets']) {
      expect((await client(deps)(path)).status, path).toBe(401);
    }
    const writes: [string, string][] = [
      ['POST', '/api/refresh'],
      ['POST', '/api/imports/balances'],
      ['POST', '/api/imports/holdings'],
      ['POST', '/api/plaid/link-token'],
      ['POST', '/api/plaid/exchange'],
      ['PUT', '/api/targets'],
      ['PATCH', '/api/household'],
      ['POST', '/api/connections/x/sync'],
      ['DELETE', '/api/connections/x'],
    ];
    for (const [method, path] of writes) {
      expect((await client(deps)(path, { method, json: {} })).status, `${method} ${path}`).toBe(401);
    }
  });

  it('keeps each household to its own data', async () => {
    const { asA, asB, accountId } = await setup();
    expect((await asA('/api/accounts')).body.accounts).toHaveLength(1);
    expect((await asB('/api/accounts')).body.accounts).toHaveLength(0);
    expect((await asB('/api/securities')).body.securities).toHaveLength(0);
    expect((await asA('/api/portfolio')).body.assets).toBeGreaterThan(0);
    expect((await asB('/api/portfolio')).body.assets).toBe(0);
    expect((await asB('/api/history?range=ALL&group=account')).body.series).toHaveLength(0);
    expect((await asA('/api/history?range=ALL&group=account')).body.series).toHaveLength(1);

    // B can't read or change A's records by id.
    expect((await asB(`/api/accounts/${accountId}/balances`)).status).toBe(404);
    expect((await asB(`/api/accounts/${accountId}`, { method: 'PATCH', json: { name: 'Mine' } })).status).toBe(404);
    expect((await asB(`/api/accounts/${accountId}/balances`, { method: 'POST', json: { date: '2026-10-02', balance: 1 } })).status).toBe(404);
    expect((await asB(`/api/accounts/${accountId}`, { method: 'DELETE' })).status).toBe(404);
    expect((await asB('/api/securities/sec-a', { method: 'PATCH', json: { classification: { categories: { cash: 1 } } } })).status).toBe(404);
    expect((await asB('/api/imports/balances', { method: 'POST', json: { accountId, rows: [{ date: '2026-01-01', balance: 1 }] } })).status).toBe(404);
    expect((await asB(`/api/history?range=ALL&group=holding&accountId=${accountId}`)).body.series).toHaveLength(0);
    expect((await asA(`/api/accounts/${accountId}`)).status).toBe(404); // no GET-by-id route; sanity
  });

  it('refuses writes a form on another site could send', async () => {
    const { deps, a } = await setup();
    const { createApp } = await import('../server/app');
    const send = (init: RequestInit) => createApp().request('http://localhost/api/accounts', init, { deps });
    const body = JSON.stringify({ name: 'x', type: 'other', currency: 'USD' });

    // A cross-site <form> can post text/plain or form-encoded bodies with the cookie attached.
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
      const response = await send({ method: 'POST', body, headers: { cookie: a.cookie, origin: 'https://evil.example', 'content-type': contentType } });
      expect(response.status, contentType).toBe(403);
    }
    const marked = await send({ method: 'POST', body, headers: { cookie: a.cookie, 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' } });
    expect(marked.status).toBe(403);

    // Same-origin requests (the app itself) go through.
    const ours = await send({ method: 'POST', body, headers: { cookie: a.cookie, 'sec-fetch-site': 'same-origin', 'content-type': 'text/plain' } });
    expect(ours.status).toBe(201);
  });

  it('sends security headers and never caches API responses', async () => {
    const { asA } = await setup();
    const response = await asA('/api/accounts');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

/** Household A with a linked Plaid login and a manual account; B signed in beside it. */
async function withLogin() {
  const plaid = fakePlaid({
    accounts: [account('brk', 'investment', 1000)],
    securities: [security('s-vti', 'VTI', 'etf', 100)],
    holdings: [holding('brk', 's-vti', 10, 100)],
  });
  const deps = await createTestDeps({ plaid });
  const a = await createHousehold(deps, 'A', 'a@example.com');
  const b = await createHousehold(deps, 'B', 'b@example.com');
  const asA = client(deps, a.cookie);
  const asB = client(deps, b.cookie);
  expect((await asA('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'investments' } })).status).toBe(200);
  await flush(deps);
  const manual = await asA('/api/accounts', { method: 'POST', json: { name: 'Brokerage', type: 'investment', currency: 'USD' } });
  expect(manual.status).toBe(201);
  const [connection] = await deps.db.select().from(schema.connections);
  return { deps, plaid, a, b, asA, asB, connectionId: connection.id, manualId: manual.body.id as string };
}

describe('tenant isolation: logins, holdings, targets and settings', () => {
  it("refuses another household's login by id, and leaves it untouched", async () => {
    const { deps, plaid, asA, asB, connectionId } = await withLogin();
    const callsBefore = plaid.state.calls.length;
    const runsBefore = (await deps.db.select().from(schema.syncRuns)).length;

    expect((await asB(`/api/connections/${connectionId}/sync`, { method: 'POST' })).status).toBe(404);
    expect((await asB(`/api/connections/${connectionId}/backfill`, { method: 'POST' })).status).toBe(404);
    expect((await asB(`/api/connections/${connectionId}/reconnect`, { method: 'POST' })).status).toBe(404);
    expect((await asB(`/api/connections/${connectionId}/activity`)).status).toBe(404);
    expect((await asB(`/api/connections/${connectionId}`, { method: 'DELETE' })).status).toBe(404);
    // Update mode would open Link on A's login with A's access token.
    expect((await asB('/api/plaid/link-token', { method: 'POST', json: { kind: 'investments', connectionId } })).status).toBe(404);
    await flush(deps);

    expect(plaid.state.calls.length).toBe(callsBefore);
    expect((await deps.db.select().from(schema.syncRuns)).length).toBe(runsBefore);
    expect((await asB('/api/connections')).body.connections).toEqual([]);
    const [connection] = (await asA('/api/connections')).body.connections;
    expect(connection).toMatchObject({ id: connectionId, status: 'ok' });
    expect((await asA('/api/accounts')).body.accounts).toHaveLength(2);
  });

  it("refuses another household's holdings by account id", async () => {
    const { asA, asB, manualId } = await withLogin();
    expect((await asA(`/api/accounts/${manualId}/holdings`, { method: 'PUT', json: { holdings: [{ ticker: 'VTI', quantity: 3, price: 100 }], version: 0 } })).status).toBe(200);

    expect((await asB(`/api/accounts/${manualId}/holdings`)).status).toBe(404);
    expect((await asB(`/api/accounts/${manualId}/holdings`, { method: 'PUT', json: { holdings: [], version: 1 } })).status).toBe(404);
    expect(
      (await asB('/api/imports/holdings', { method: 'POST', json: { accountId: manualId, rows: [{ date: '2026-10-01', ticker: 'VTI', quantity: 99 }] } })).status,
    ).toBe(404);

    const holdings = (await asA(`/api/accounts/${manualId}/holdings`)).body.holdings as { ticker: string; quantity: number }[];
    expect(holdings.map((row) => [row.ticker, row.quantity])).toEqual([['VTI', 3]]);
  });

  it('keeps targets, quotes and household settings to each household', async () => {
    const { asA, asB, manualId } = await withLogin();
    const target = { weights: { us_stock: 1 }, bandPct: 5, excludedAccountIds: [manualId], excludedCategories: [] };
    expect((await asA('/api/targets', { method: 'PUT', json: target })).status).toBe(200);
    expect((await asB('/api/targets')).body.target ?? null).toBeNull();
    // B saving its own target doesn't touch A's.
    expect((await asB('/api/targets', { method: 'PUT', json: { ...target, excludedAccountIds: [], weights: { cash: 1 } } })).status).toBe(200);
    expect((await asB('/api/targets')).body.target).toMatchObject({ weights: { cash: 1 } });
    expect((await asA('/api/targets')).body.target).toMatchObject({ weights: { us_stock: 1 }, excludedAccountIds: [manualId] });

    expect((await asB('/api/quotes')).body).toEqual({ quotes: [], closes: [] });
    expect((await asA('/api/quotes')).body.closes.map((row: { ticker: string }) => row.ticker)).toContain('VTI');

    expect((await asB('/api/household', { method: 'PATCH', json: { name: 'Renamed', displayCurrency: 'AUD' } })).status).toBe(200);
    expect((await asA('/api/auth/me')).body.household).toMatchObject({ name: 'A', displayCurrency: 'USD' });
    expect((await asB('/api/auth/me')).body.household).toMatchObject({ name: 'Renamed', displayCurrency: 'AUD' });
    expect((await asB('/api/auth/me')).body.household.members.map((member: { email: string }) => member.email)).toEqual(['b@example.com']);
  });

  it('a refresh syncs only your own logins', async () => {
    const { deps, plaid, asB } = await withLogin();
    const callsBefore = plaid.state.calls.length;
    expect((await asB('/api/refresh', { method: 'POST' })).status).toBe(200);
    await flush(deps);
    expect(plaid.state.calls.length).toBe(callsBefore);
  });

  it("a webhook acts only on its login's household", async () => {
    const { deps, a, b, asB } = await withLogin();
    const before = await asB('/api/accounts');
    const body = JSON.stringify({ webhook_type: 'ITEM', webhook_code: 'ERROR', item_id: 'item-1', error: { error_code: 'ITEM_LOGIN_REQUIRED' } });
    const response = await client(deps)('/api/plaid/webhook', {
      method: 'POST',
      body,
      headers: { 'plaid-verification': await signWebhook(body, deps.now()), 'content-type': 'application/json' },
    });
    expect(response.status).toBe(200);
    const runs = await deps.db.select({ householdId: schema.syncRuns.householdId }).from(schema.syncRuns);
    expect(new Set(runs.map((run) => run.householdId))).toEqual(new Set([a.householdId]));
    expect(runs.some((run) => run.householdId === b.householdId)).toBe(false);
    expect((await asB('/api/accounts')).body).toEqual(before.body);
  });
});

describe('large imports', () => {
  it('stay within D1 parameter limits', async () => {
    const { asA, accountId } = await setup();
    const rows = Array.from({ length: 400 }, (_, index) => ({
      date: new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10),
      balance: 1000 + index,
    }));
    const result = await asA('/api/imports/balances', { method: 'POST', json: { accountId, rows } });
    expect(result.status).toBe(200);
    expect(result.body.imported).toBe(400);
  });
});
