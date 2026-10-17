import { describe, expect, it } from 'vitest';
import * as schema from '../server/db/schema';
import { client, createHousehold, createTestDeps } from './helpers';

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
    for (const path of ['/api/accounts', '/api/portfolio', '/api/history', '/api/securities', '/api/connections', '/api/auth/me']) {
      expect((await client(deps)(path)).status, path).toBe(401);
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
