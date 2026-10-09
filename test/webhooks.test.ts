import { describe, expect, it } from 'vitest';
import * as schema from '../server/db/schema';
import { account, fakePlaid, holding, security, signWebhook } from './fakes';
import { client, createHousehold, createTestDeps, flush } from './helpers';

async function setup(kind: 'investments' | 'banking' = 'investments') {
  const plaid = fakePlaid({
    accounts: [account('brk', 'investment', 1000)],
    securities: [security('s-vti', 'VTI', 'etf', 100)],
    holdings: [holding('brk', 's-vti', 10, 100)],
    assetReportReady: true,
    historicalBalances: { brk: [{ date: '2026-10-01', current: 900 }] },
  });
  const deps = await createTestDeps({ plaid });
  const home = await createHousehold(deps, 'Home', 'me@example.com');
  await client(deps, home.cookie)('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind } });
  await flush(deps);
  // Webhooks come from Plaid's servers: no cookie, no browser Origin.
  const send = async (event: Record<string, unknown>, options: { signature?: string; issuedAt?: Date } = {}) => {
    const body = JSON.stringify(event);
    const signature = options.signature ?? (await signWebhook(body, options.issuedAt ?? deps.now()));
    const response = await client(deps)('/api/plaid/webhook', {
      method: 'POST',
      body,
      headers: { 'plaid-verification': signature, 'content-type': 'application/json', origin: 'https://plaid.com' },
    });
    await flush(deps);
    return response;
  };
  const connection = async () => (await deps.db.select().from(schema.connections))[0];
  return { deps, plaid, send, connection, api: client(deps, home.cookie) };
}

describe('Plaid webhooks', () => {
  it('rejects unsigned, forged and stale webhooks', async () => {
    const { send, plaid } = await setup();
    const before = plaid.state.calls.length;
    const event = { webhook_type: 'HOLDINGS', webhook_code: 'DEFAULT_UPDATE', item_id: 'item-1' };
    expect((await send(event, { signature: '' })).status).toBe(401);
    expect((await send(event, { signature: 'a.b.c' })).status).toBe(401);
    expect((await send(event, { issuedAt: new Date(Date.parse('2026-10-09T01:00:00Z')) })).status).toBe(401);
    const otherBody = await signWebhook('{"webhook_type":"ITEM"}', new Date('2026-10-09T02:00:00Z'));
    expect((await send(event, { signature: otherBody })).status).toBe(401);
    expect(plaid.state.calls.length).toBe(before);
  });

  it('syncs on holdings updates', async () => {
    const { send, plaid, api } = await setup();
    plaid.state.holdings = [holding('brk', 's-vti', 12, 100)];
    expect((await send({ webhook_type: 'HOLDINGS', webhook_code: 'DEFAULT_UPDATE', item_id: 'item-1' })).status).toBe(200);
    expect((await api('/api/portfolio')).body.netWorth).toBe(1200_00);
  });

  it('tracks connection health', async () => {
    const { send, connection, plaid } = await setup();
    await send({ webhook_type: 'ITEM', webhook_code: 'ERROR', item_id: 'item-1', error: { error_code: 'ITEM_LOGIN_REQUIRED' } });
    expect(await connection()).toMatchObject({ status: 'login_required', errorCode: 'ITEM_LOGIN_REQUIRED' });

    await send({ webhook_type: 'ITEM', webhook_code: 'ERROR', item_id: 'item-1', error: { error_code: 'INSTITUTION_DOWN' } });
    expect((await connection()).status).toBe('error');

    await send({ webhook_type: 'ITEM', webhook_code: 'PENDING_EXPIRATION', item_id: 'item-1' });
    expect((await connection()).status).toBe('pending_expiration');

    plaid.state.failWith = null;
    await send({ webhook_type: 'ITEM', webhook_code: 'LOGIN_REPAIRED', item_id: 'item-1' });
    expect((await connection()).status).toBe('ok');

    await send({ webhook_type: 'ITEM', webhook_code: 'USER_PERMISSION_REVOKED', item_id: 'item-1' });
    expect((await connection()).status).toBe('error');
  });

  it('ignores unknown items and events', async () => {
    const { send, connection } = await setup();
    expect((await send({ webhook_type: 'ITEM', webhook_code: 'ERROR', item_id: 'someone-else' })).status).toBe(200);
    expect((await send({ webhook_type: 'TRANSFERS', webhook_code: 'WHATEVER', item_id: 'item-1' })).status).toBe(200);
    expect((await connection()).status).toBe('ok');
  });

  it('collects balance history when an asset report is ready, or records its failure', async () => {
    const ready = await setup('banking');
    expect((await ready.connection()).assetReportId).toBe('ar-1');
    // The webhook carries the report id, not the item.
    await ready.send({ webhook_type: 'ASSETS', webhook_code: 'PRODUCT_READY', asset_report_id: 'ar-1' });
    expect(await ready.connection()).toMatchObject({ backfillStatus: 'done', assetReportId: null });

    const failed = await setup('banking');
    await failed.send({ webhook_type: 'ASSETS', webhook_code: 'ERROR', asset_report_id: 'ar-1' });
    expect(await failed.connection()).toMatchObject({ backfillStatus: 'failed', assetReportTokenEnc: null });
  });

  it('answers 503 without Plaid configured', async () => {
    const deps = await createTestDeps();
    const response = await client(deps)('/api/plaid/webhook', { method: 'POST', body: '{}', headers: { origin: 'https://plaid.com' } });
    expect(response.status).toBe(503);
  });
});
