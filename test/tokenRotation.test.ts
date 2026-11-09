/**
 * Moving Plaid tokens to a new encryption key: queued by the first request
 * once the key is set, each login's tokens re-encrypted and noted in its
 * Activity, and the login still syncing after the old key is gone.
 */
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../server/db/schema';
import { withNextKey } from '../server/services/crypto';
import { resetRotationQueue, rotateAllTokens } from '../server/services/tokenRotation';
import { syncConnection } from '../server/services/sync';
import { Tenant } from '../server/db/tenant';
import { account, fakePlaid } from './fakes';
import { client, createHousehold, createTestDeps, settle, TEST_KEY } from './helpers';

const FRESH = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

async function linked() {
  const plaid = fakePlaid({ accounts: [account('chk', 'depository', 500)], historicalBalances: { chk: [{ date: '2026-10-01', current: 500 }] }, itemProducts: ['assets'] });
  const deps = await createTestDeps({ plaid });
  const home = await createHousehold(deps, 'Home', 'me@example.com');
  const api = client(deps, home.cookie);
  await api('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'account' } });
  await settle(deps, 20);
  const tenant = new Tenant(deps.db, home.householdId);
  const token = async () => (await deps.db.select().from(schema.connections))[0].accessTokenEnc;
  return { deps, api, tenant, token };
}

describe('token rotation', () => {
  beforeEach(() => resetRotationQueue());

  it('moves every token to the new key once it is set, noting it in Activity, and keeps syncing after the swap', async () => {
    const { deps, api, tenant, token } = await linked();
    expect(await token()).toMatch(/^v1\./);
    const [connection] = await deps.db.select().from(schema.connections);

    // The new key set as TOKEN_ENC_KEY_NEXT: the first request queues the move, once.
    deps.config.tokenEncKey = withNextKey(TEST_KEY, FRESH);
    deps.config.tokenRotating = true;
    await api('/api/accounts');
    await api('/api/accounts');
    expect((await deps.db.select().from(schema.jobs).where(eq(schema.jobs.type, 'rotate_tokens'))).length).toBe(1);
    await settle(deps);
    expect(await token()).toMatch(/^v2\./);
    const runs = await deps.db.select().from(schema.syncRuns).where(eq(schema.syncRuns.action, 'tokens'));
    expect(runs).toMatchObject([{ connectionId: connection.id, trigger: 'key', note: 'Moved its tokens to the new encryption key.', outcome: 'ok' }]);

    // The swap: TOKEN_ENC_KEY is the new key (set bare), TOKEN_ENC_KEY_NEXT gone; the login still syncs.
    deps.config.tokenEncKey = FRESH;
    deps.config.tokenRotating = false;
    const later = deps.now().getTime() + 86400_000;
    deps.now = () => new Date(later);
    await expect(syncConnection(deps, tenant, connection.id, 'manual')).resolves.toMatchObject({ status: 'ok' });
  });

  it("the nightly pass moves what's left, and leaves what it can't open", async () => {
    const { deps, token } = await linked();
    deps.config.tokenEncKey = withNextKey(TEST_KEY, FRESH);
    deps.config.tokenRotating = true;
    expect(await rotateAllTokens(deps)).toEqual({ rotated: 1, remaining: 0 });
    expect(await token()).toMatch(/^v2\./);
    expect(await rotateAllTokens(deps)).toEqual({ rotated: 0, remaining: 0 });

    // A key that isn't the one it's under: left as it is, counted.
    const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
    deps.config.tokenEncKey = withNextKey(`v5:${other}`, btoa(String.fromCharCode(...new Uint8Array(32).fill(3))));
    expect(await rotateAllTokens(deps)).toEqual({ rotated: 0, remaining: 1 });
  });

  it('queues nothing without a new key', async () => {
    const { deps, api } = await linked();
    await api('/api/accounts');
    expect(await deps.db.select().from(schema.jobs).where(eq(schema.jobs.type, 'rotate_tokens'))).toEqual([]);
  });
});
