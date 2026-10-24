import { desc, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../server/db/schema';
import { account, fakePlaid, holding, security, signWebhook } from './fakes';
import { client, createHousehold, createTestDeps, flush, nightly, settle, TODAY } from './helpers';

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
    expect((await api('/api/connections')).body.connections[0].historyProgress).toEqual({ done: 0, total: 0, waitingUntil: null });
    await flush(deps);
    expect((await api('/api/connections')).body.connections[0].historyProgress).toBeNull();
    const rows = await deps.db.select().from(schema.accounts);
    expect(rows.find((row) => row.externalId === 'ira')).toMatchObject({ missingSince: null });
    expect(rows.find((row) => row.externalId === 'brk')?.missingSince).not.toBeNull();
    const brkId = rows.find((row) => row.externalId === 'brk')!.id;
    const brkHistory = await deps.db.select().from(schema.accountDaily);
    expect(brkHistory.some((row) => row.accountId === rows.find((r) => r.externalId === 'brk')!.id)).toBe(true); // kept
    expect(brkHistory.some((row) => row.accountId === rows.find((r) => r.externalId === 'ira')!.id && row.source === 'backfill')).toBe(true); // loaded
    expect((await deps.db.select().from(schema.syncRuns)).filter((run) => run.action === 'history').length).toBe(historyBefore + 1);
    expect((await connection()).newAccountsAt).toBeNull();
    expect((await api('/api/portfolio')).body.netWorth).toBe(2000_00); // only what's shared counts
    // The chart agrees: the brokerage account's last balance isn't carried on.
    const chart = (await api('/api/history?range=1M&group=total')).body;
    expect(chart.series[0].values.at(-1)).toBe(2000_00);

    // Choosing the brokerage account again: Plaid gives it a new account_id,
    // but it matches the deselected account exactly, so it takes it over,
    // history and all, without a new history load.
    plaid.state.accounts = [account('brk-again', 'investment', 1000, { name: 'brk' }), account('ira', 'investment', 2000)];
    plaid.state.holdings = [holding('brk-again', 's-vti', 10, 100), holding('ira', 's-vti', 20, 100)];
    const again = await api(`/api/connections/${before.id}/accounts-chosen`, { method: 'POST' });
    expect(again.body).toMatchObject({ added: 1, historyQueued: false });
    await flush(deps);
    const back = (await deps.db.select().from(schema.accounts)).filter((row) => row.plaidName === 'brk');
    expect(back).toEqual([expect.objectContaining({ id: brkId, externalId: 'brk-again', missingSince: null })]);
    const days = (await deps.db.select().from(schema.accountDaily)).filter((row) => row.accountId === brkId);
    expect(days.some((row) => row.source === 'backfill')).toBe(true); // its old history
    expect(days.some((row) => row.date === TODAY)).toBe(true); // and today's
    expect((await deps.db.select().from(schema.holdings)).filter((row) => row.accountId === brkId)).toHaveLength(1);
    expect((await deps.db.select().from(schema.syncRuns)).flatMap((run) => (run.changes as { kind: string }[] | null) ?? []).some((change) => change.kind === 'account_returned')).toBe(true);
    expect((await api('/api/portfolio')).body.netWorth).toBe(3000_00);
    // The next sync knows it by its new id.
    await api(`/api/connections/${before.id}/accounts-chosen`, { method: 'POST' });
    expect((await deps.db.select().from(schema.accounts)).filter((row) => row.plaidName === 'brk')).toHaveLength(1);
  });

  it('Choose accounts: a new bank account waits for the person before a bank report; investment history loads either way', async () => {
    const { deps, plaid, api, send, connection } = await setup('account');
    await send({ webhook_type: 'ASSETS', webhook_code: 'PRODUCT_READY', asset_report_id: 'ar-1' }); // the first load's report
    expect((await connection()).assetReportTokenEnc).toBeNull();
    await deps.db.update(schema.connections).set({ hasInvestments: true }); // a bank login with investment accounts too
    const [login] = (await api('/api/connections')).body.connections;
    expect(login.hasBalanceHistory).toBe(true);
    const reports = () => plaid.state.calls.filter((call) => call === 'asset_report:create').length;
    const before = reports();
    const daily = async (externalId: string) => {
      const [row] = (await deps.db.select().from(schema.accounts)).filter((candidate) => candidate.externalId === externalId);
      return (await deps.db.select().from(schema.accountDaily)).filter((day) => day.accountId === row.id && day.source === 'backfill');
    };

    // An IRA and a card chosen in Link.
    plaid.state.accounts = [account('brk', 'investment', 1000), account('ira', 'investment', 2000), account('card', 'credit', 300)];
    plaid.state.holdings = [holding('brk', 's-vti', 10, 100), holding('ira', 's-vti', 20, 100)];
    plaid.state.historicalBalances = { card: [{ date: '2026-10-01', current: 250 }] };
    const chosen = await api(`/api/connections/${login.id}/accounts-chosen`, { method: 'POST' });
    expect(chosen.body).toMatchObject({ added: 2, historyQueued: false });
    const asked = chosen.body.newAccounts as { id: string; name: string; bank: boolean }[];
    expect(asked.map(({ name, bank }) => ({ name, bank })).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'card', bank: true },
      { name: 'ira', bank: false },
    ]);
    await flush(deps);
    expect(reports()).toBe(before); // nothing asked of Plaid until the person answers

    // Not now: the IRA's history, no report.
    const ira = asked.find((entry) => !entry.bank)!;
    expect((await api(`/api/connections/${login.id}/new-accounts-history`, { method: 'POST', json: { accountIds: [ira.id], bankReport: false } })).body.queued).toBe(true);
    await flush(deps);
    expect(reports()).toBe(before);
    expect((await daily('ira')).length).toBeGreaterThan(0);
    expect(await daily('card')).toEqual([]);
    const notes = (await deps.db.select().from(schema.syncRuns)).map((run) => run.note);
    expect(notes).toContain('History for newly added accounts, without a bank report.');

    // Load history: one report, the card's days filled.
    const card = asked.find((entry) => entry.bank)!;
    expect((await api(`/api/connections/${login.id}/new-accounts-history`, { method: 'POST', json: { accountIds: [card.id], bankReport: true } })).body.queued).toBe(true);
    await flush(deps);
    expect(reports()).toBe(before + 1);
    await settle(deps); // its first check, a minute on
    expect((await daily('card')).length).toBeGreaterThan(0);

    // Only this login's accounts.
    expect((await api(`/api/connections/${login.id}/new-accounts-history`, { method: 'POST', json: { accountIds: ['elsewhere'], bankReport: true } })).status).toBe(404);
  });

  it('a deselected account can be deleted with its history; one still reported cannot', async () => {
    const { deps, plaid, api } = await setup();
    const [login] = (await api('/api/connections')).body.connections;
    plaid.state.accounts = [account('ira', 'investment', 2000)];
    plaid.state.holdings = [holding('ira', 's-vti', 20, 100)];
    await api(`/api/connections/${login.id}/accounts-chosen`, { method: 'POST' });
    await flush(deps);
    const rows = await deps.db.select().from(schema.accounts);
    const brk = rows.find((row) => row.externalId === 'brk')!;
    const ira = rows.find((row) => row.externalId === 'ira')!;
    expect(brk.missingSince).not.toBeNull();

    expect((await api(`/api/accounts/${ira.id}`, { method: 'DELETE' })).status).toBe(409);
    expect((await api(`/api/accounts/${brk.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await deps.db.select().from(schema.accounts)).map((row) => row.externalId)).toEqual(['ira']);
    for (const table of [schema.accountDaily, schema.holdingDaily, schema.holdings, schema.investmentTransactions]) {
      expect((await deps.db.select().from(table)).filter((row) => row.accountId === brk.id)).toEqual([]);
    }
    expect((await deps.db.select().from(schema.syncRuns)).map((run) => run.note)).toContain('Deleted “brk” (no longer reported) and its stored history.');
    expect((await api('/api/portfolio')).body.netWorth).toBe(2000_00);
  });

  it('a returning account is only matched when exactly one fits', async () => {
    const { deps, plaid, api } = await setup();
    const [login] = (await api('/api/connections')).body.connections;
    // Two look-alike cards (no mask), then both deselected.
    plaid.state.accounts = [account('brk', 'investment', 1000), account('c1', 'credit', 100, { name: 'Card', mask: null }), account('c2', 'credit', 200, { name: 'Card', mask: null })];
    await api(`/api/connections/${login.id}/accounts-chosen`, { method: 'POST' });
    plaid.state.accounts = [account('brk', 'investment', 1000)];
    await api(`/api/connections/${login.id}/accounts-chosen`, { method: 'POST' });
    // One comes back under a new id: which one is a guess, so it's a new account.
    plaid.state.accounts = [account('brk', 'investment', 1000), account('c3', 'credit', 100, { name: 'Card', mask: null })];
    await api(`/api/connections/${login.id}/accounts-chosen`, { method: 'POST' });
    const cards = (await deps.db.select().from(schema.accounts)).filter((row) => row.plaidName === 'Card');
    expect(cards.map((row) => [row.externalId, row.missingSince === null]).sort()).toEqual([
      ['c1', false],
      ['c2', false],
      ['c3', true],
    ]);
  });

  it('a webhook fetches only the investment data it says changed', async () => {
    const { plaid, send } = await setup();
    const fetchedBy = async (event: Record<string, unknown>) => {
      const before = plaid.state.calls.length;
      await send({ item_id: 'item-1', ...event });
      return plaid.state.calls.slice(before).filter((call) => call === 'holdings' || call === 'transactions');
    };
    expect(await fetchedBy({ webhook_type: 'HOLDINGS', webhook_code: 'DEFAULT_UPDATE' })).toEqual(['holdings']);
    expect(await fetchedBy({ webhook_type: 'INVESTMENTS_TRANSACTIONS', webhook_code: 'DEFAULT_UPDATE' })).toEqual(['transactions']);
    expect(await fetchedBy({ webhook_type: 'ASSETS', webhook_code: 'PRODUCT_READY', asset_report_id: 'ar-1' })).toEqual([]);
    expect(await fetchedBy({ webhook_type: 'ITEM', webhook_code: 'LOGIN_REPAIRED' })).toEqual(['holdings', 'transactions']);
  });

  it('a transactions-only sync leaves holdings as they are', async () => {
    const { deps, plaid, send } = await setup();
    const before = await deps.db.select().from(schema.holdings);
    plaid.state.holdings = []; // what a holdings call would say; not asked
    await send({ webhook_type: 'INVESTMENTS_TRANSACTIONS', webhook_code: 'DEFAULT_UPDATE', item_id: 'item-1' });
    expect(await deps.db.select().from(schema.holdings)).toEqual(before);
  });

  it('the nightly sync always fetches holdings, and transactions unless a webhook already did since the market closed', async () => {
    const { deps, plaid, send } = await setup();
    const at = (iso: string) => {
      deps.now = () => new Date(iso);
    };
    const fetched = async (operation: () => Promise<unknown>) => {
      const before = plaid.state.calls.length;
      await operation();
      return plaid.state.calls.slice(before).filter((call) => call === 'holdings' || call === 'transactions');
    };
    // Linked (and synced) the evening of the 8th; next morning, Plaid says transactions changed.
    at('2026-10-09T14:00:00Z'); // 10am New York
    expect(await fetched(() => send({ webhook_type: 'INVESTMENTS_TRANSACTIONS', webhook_code: 'DEFAULT_UPDATE', item_id: 'item-1' }))).toEqual(['transactions']);
    // That night: fetched before today's close (4pm), so again (a trade since would be missed otherwise).
    at('2026-10-10T02:00:00Z');
    expect(await fetched(() => nightly(deps))).toEqual(['holdings', 'transactions']);
    // The 10th: Plaid's transactions update arrives after the close; that night only holdings
    // are fetched (always: the institution's latest prices).
    at('2026-10-10T21:30:00Z'); // 5:30pm New York
    expect(await fetched(() => send({ webhook_type: 'INVESTMENTS_TRANSACTIONS', webhook_code: 'DEFAULT_UPDATE', item_id: 'item-1' }))).toEqual(['transactions']);
    at('2026-10-11T02:00:00Z');
    expect(await fetched(() => nightly(deps))).toEqual(['holdings']);
    const notes = (await deps.db.select().from(schema.syncRuns)).map((run) => run.note);
    expect(notes).toContain("Transactions already fetched since the market closed (Plaid's update); not fetched again.");
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
