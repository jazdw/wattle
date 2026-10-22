import { desc, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../server/db/schema';
import { account, fakePlaid, holding, security, signWebhook } from './fakes';
import { client, createHousehold, createTestDeps, flush } from './helpers';

async function setup(kind: 'investments' | 'account' = 'investments') {
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

  it("drops webhooks for logins that aren't ours without asking Plaid for a key", async () => {
    const { send, plaid } = await setup();
    const lookups = plaid.state.webhookKeyLookups;
    const calls = plaid.state.calls.length;
    const forged = { webhook_type: 'HOLDINGS', webhook_code: 'DEFAULT_UPDATE', item_id: 'someone-elses-item' };
    expect((await send(forged, { signature: await signWebhook(JSON.stringify(forged), new Date(), 'never-seen-kid') })).status).toBe(200);
    expect((await send({ webhook_type: 'ASSETS', webhook_code: 'PRODUCT_READY', asset_report_id: 'unknown' })).status).toBe(200);
    expect(plaid.state.webhookKeyLookups).toBe(lookups);
    expect(plaid.state.calls.length).toBe(calls);
  });

  it('syncs on holdings updates', async () => {
    const { send, plaid, api } = await setup();
    plaid.state.holdings = [holding('brk', 's-vti', 12, 100)];
    expect((await send({ webhook_type: 'HOLDINGS', webhook_code: 'DEFAULT_UPDATE', item_id: 'item-1' })).status).toBe(200);
    expect((await api('/api/portfolio')).body.netWorth).toBe(1200_00);
  });

  it('tracks connection health', async () => {
    const { deps, send, connection, plaid, api } = await setup();
    await send({ webhook_type: 'ITEM', webhook_code: 'ERROR', item_id: 'item-1', error: { error_code: 'ITEM_LOGIN_REQUIRED' } });
    expect(await connection()).toMatchObject({ status: 'login_required', errorCode: 'ITEM_LOGIN_REQUIRED' });
    // The status change is in the sync log too.
    const [logged] = await deps.db.select().from(schema.syncRuns).orderBy(desc(sql`rowid`)).limit(1);
    expect(logged).toMatchObject({ trigger: 'webhook', note: 'Plaid reported ITEM:ERROR (ITEM_LOGIN_REQUIRED).' });

    await send({ webhook_type: 'ITEM', webhook_code: 'ERROR', item_id: 'item-1', error: { error_code: 'INSTITUTION_DOWN' } });
    expect((await connection()).status).toBe('error');

    // A consent warning is its own field: it doesn't hide the error, and a
    // sync doesn't clear it (re-linking does).
    await send({ webhook_type: 'ITEM', webhook_code: 'PENDING_EXPIRATION', item_id: 'item-1', consent_expiration_time: '2026-11-01T00:00:00Z' });
    expect(await connection()).toMatchObject({ status: 'error', consentExpiresAt: Date.parse('2026-11-01T00:00:00Z') });
    expect((await connection()).consentWarningAt).not.toBeNull();
    expect((await api('/api/connections')).body.connections[0].status).toBe('error');

    plaid.state.failWith = null;
    await send({ webhook_type: 'ITEM', webhook_code: 'LOGIN_REPAIRED', item_id: 'item-1' });
    expect((await connection()).status).toBe('ok');
    expect((await api('/api/connections')).body.connections[0].status).toBe('pending_expiration');

    await send({ webhook_type: 'ITEM', webhook_code: 'USER_PERMISSION_REVOKED', item_id: 'item-1' });
    expect((await connection()).status).toBe('error');
  });

  it('Choose accounts: new accounts Plaid reports are flagged; choosing adds them (with history) and removes deselected ones (history kept)', async () => {
    const { deps, send, connection, plaid, api } = await setup();
    const [before] = (await api('/api/connections')).body.connections;
    expect(before.newAccountsAvailable).toBe(false);
    await send({ webhook_type: 'ITEM', webhook_code: 'NEW_ACCOUNTS_AVAILABLE', item_id: 'item-1' });
    expect((await api('/api/connections')).body.connections[0].newAccountsAvailable).toBe(true);

    // Link opens with account selection for this login.
    expect((await api('/api/plaid/link-token', { method: 'POST', json: { kind: 'investments', connectionId: before.id, chooseAccounts: true } })).status).toBe(200);
    expect(plaid.state.calls).toContain('link:investments:choose');
    expect((await api('/api/plaid/link-token', { method: 'POST', json: { kind: 'investments', chooseAccounts: true } })).status).toBe(400);

    // In Link: the new IRA chosen, the brokerage account deselected. Just
    // linked, so a plain Sync would wait out its cooldown; this doesn't.
    plaid.state.accounts = [account('ira', 'investment', 2000)];
    plaid.state.holdings = [holding('ira', 's-vti', 20, 100)];
    const historyBefore = (await deps.db.select().from(schema.syncRuns)).filter((run) => run.action === 'history').length;
    const chosen = await api(`/api/connections/${before.id}/accounts-chosen`, { method: 'POST' });
    expect(chosen.body).toMatchObject({ added: 1, historyQueued: true });
    // Before its plan has run, the load already shows, so the page keeps watching.
    expect((await api('/api/connections')).body.connections[0].historyProgress).toEqual({ done: 0, total: 0 });
    await flush(deps);
    expect((await api('/api/connections')).body.connections[0].historyProgress).toBeNull();
    const rows = await deps.db.select().from(schema.accounts);
    expect(rows.find((row) => row.externalId === 'ira')).toMatchObject({ missingSince: null });
    expect(rows.find((row) => row.externalId === 'brk')?.missingSince).not.toBeNull();
    const brkHistory = await deps.db.select().from(schema.accountDaily);
    expect(brkHistory.some((row) => row.accountId === rows.find((r) => r.externalId === 'brk')!.id)).toBe(true); // kept
    expect(brkHistory.some((row) => row.accountId === rows.find((r) => r.externalId === 'ira')!.id && row.source === 'backfill')).toBe(true); // loaded
    expect((await deps.db.select().from(schema.syncRuns)).filter((run) => run.action === 'history').length).toBe(historyBefore + 1);
    expect((await connection()).newAccountsAt).toBeNull();
    expect((await api('/api/portfolio')).body.netWorth).toBe(2000_00); // only what's shared counts

    // Choosing the brokerage account again brings it back, without a new history load.
    plaid.state.accounts = [account('brk', 'investment', 1000), account('ira', 'investment', 2000)];
    plaid.state.holdings = [holding('brk', 's-vti', 10, 100), holding('ira', 's-vti', 20, 100)];
    const again = await api(`/api/connections/${before.id}/accounts-chosen`, { method: 'POST' });
    expect(again.body).toMatchObject({ added: 1, historyQueued: false });
    expect((await api('/api/portfolio')).body.netWorth).toBe(3000_00);
  });

  it('ignores unknown items and events', async () => {
    const { send, connection } = await setup();
    expect((await send({ webhook_type: 'ITEM', webhook_code: 'ERROR', item_id: 'someone-else' })).status).toBe(200);
    expect((await send({ webhook_type: 'TRANSFERS', webhook_code: 'WHATEVER', item_id: 'item-1' })).status).toBe(200);
    expect((await connection()).status).toBe('ok');
  });

  it('collects balance history when an asset report is ready, or records its failure', async () => {
    const ready = await setup('account');
    expect((await ready.connection()).assetReportId).toBe('ar-1');
    // The webhook carries the report id, not the item.
    await ready.send({ webhook_type: 'ASSETS', webhook_code: 'PRODUCT_READY', asset_report_id: 'ar-1' });
    expect(await ready.connection()).toMatchObject({ backfillStatus: 'done', assetReportId: null });

    const failed = await setup('account');
    failed.plaid.state.assetReportGetError = 'ASSET_REPORT_GENERATION_FAILED';
    // The webhook triggers a sync, which asks Plaid and records the failure.
    await failed.send({ webhook_type: 'ASSETS', webhook_code: 'ERROR', asset_report_id: 'ar-1' });
    expect(await failed.connection()).toMatchObject({ backfillStatus: 'failed', assetReportTokenEnc: null });
  });

  it('answers 503 without Plaid configured', async () => {
    const deps = await createTestDeps();
    const response = await client(deps)('/api/plaid/webhook', { method: 'POST', body: '{}', headers: { origin: 'https://plaid.com' } });
    expect(response.status).toBe(503);
  });
});
