import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToBase64Url } from '../server/lib/encoding';
import { accessIssuer, clearAccessKeyCache, verifyAccessToken } from '../server/services/accessJwt';
import { client, createHousehold, createTestDeps } from './helpers';

const TEAM = 'wattle-team.cloudflareaccess.com';
const AUD = 'aud-tag-123';
const NOW = new Date('2026-10-09T02:00:00Z');

const encode = (value: unknown) => bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));

async function rsaKey(kid: string) {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid, alg: 'RS256', use: 'sig' };
  const sign = async (claims: Record<string, unknown>, header: Record<string, unknown> = {}) => {
    const head = `${encode({ alg: 'RS256', kid, typ: 'JWT', ...header })}.${encode(claims)}`;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(head));
    return `${head}.${bytesToBase64Url(new Uint8Array(signature))}`;
  };
  return { jwk, sign };
}

const claims = (overrides: Record<string, unknown> = {}) => ({
  iss: `https://${TEAM}`,
  aud: [AUD],
  email: 'me@example.com',
  exp: NOW.getTime() / 1000 + 3600,
  nbf: NOW.getTime() / 1000 - 10,
  ...overrides,
});

let published: object[] = [];
const certsRequests: string[] = [];
const fakeFetch = (async (input: RequestInfo | URL) => {
  certsRequests.push(String(input));
  return Response.json({ keys: published });
}) as typeof fetch;

beforeEach(() => {
  clearAccessKeyCache();
  certsRequests.length = 0;
});
afterEach(() => vi.unstubAllGlobals());

describe('verifyAccessToken', () => {
  const config = { teamDomain: TEAM, audience: AUD };

  it('accepts a valid token and caches the keys', async () => {
    const key = await rsaKey('k1');
    published = [key.jwk];
    expect(await verifyAccessToken(config, await key.sign(claims()), NOW, fakeFetch)).toBe(true);
    expect(await verifyAccessToken(config, await key.sign(claims()), NOW, fakeFetch)).toBe(true);
    expect(certsRequests).toEqual([`https://${TEAM}/cdn-cgi/access/certs`]);
  });

  it('rejects wrong audience, issuer, expiry, algorithm and signature', async () => {
    const key = await rsaKey('k1');
    const other = await rsaKey('k1'); // same kid, different key
    published = [key.jwk];
    const check = async (token: string) => verifyAccessToken(config, token, NOW, fakeFetch);
    expect(await check(await key.sign(claims({ aud: ['someone-else'] })))).toBe(false);
    expect(await check(await key.sign(claims({ iss: 'https://evil.cloudflareaccess.com' })))).toBe(false);
    expect(await check(await key.sign(claims({ exp: NOW.getTime() / 1000 - 3600 })))).toBe(false);
    expect(await check(await key.sign(claims({ nbf: NOW.getTime() / 1000 + 3600 })))).toBe(false);
    expect(await check(await key.sign(claims(), { alg: 'HS256' }))).toBe(false);
    expect(await check(await other.sign(claims()))).toBe(false);
    expect(await check('not.a.jwt')).toBe(false);
    expect(await verifyAccessToken(config, undefined, NOW, fakeFetch)).toBe(false);
  });

  it('picks up rotated keys: refetches for an unknown key id, and hourly', async () => {
    // jose times its key cache with the system clock.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const at = (offsetMs: number) => {
        const date = new Date(NOW.getTime() + offsetMs);
        vi.setSystemTime(date);
        return date;
      };
      const first = await rsaKey('k1');
      const second = await rsaKey('k2');
      published = [first.jwk];
      expect(await verifyAccessToken(config, await first.sign(claims()), at(0), fakeFetch)).toBe(true);

      // Access rotates to k2. Within the cooldown an unknown kid doesn't refetch…
      published = [second.jwk, first.jwk];
      expect(await verifyAccessToken(config, await second.sign(claims()), at(30_000), fakeFetch)).toBe(false);
      // …after it, it does.
      expect(await verifyAccessToken(config, await second.sign(claims()), at(120_000), fakeFetch)).toBe(true);
      expect(certsRequests).toHaveLength(2);

      // The hourly refresh drops keys Access has retired.
      published = [second.jwk];
      const later = at(2 * 3600_000);
      expect(await verifyAccessToken(config, await first.sign(claims({ exp: later.getTime() / 1000 + 600 })), later, fakeFetch)).toBe(false);
      expect(certsRequests).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when the keys cannot be fetched', async () => {
    const key = await rsaKey('k1');
    const failing = (async () => new Response('', { status: 503 })) as typeof fetch;
    expect(await verifyAccessToken(config, await key.sign(claims()), NOW, failing)).toBe(false);
  });

  it('accepts a team name, host or URL', () => {
    expect(accessIssuer('wattle-team')).toBe(`https://${TEAM}`);
    expect(accessIssuer(TEAM)).toBe(`https://${TEAM}`);
    expect(accessIssuer(`https://${TEAM}/`)).toBe(`https://${TEAM}`);
  });
});

describe('Access check on the API', () => {
  async function setup(configured: boolean) {
    const key = await rsaKey('k1');
    published = [key.jwk];
    vi.stubGlobal('fetch', fakeFetch);
    const deps = await createTestDeps();
    if (configured) deps.config.access = { teamDomain: TEAM, audience: AUD };
    const home = await createHousehold(deps, 'Home', 'me@example.com');
    return { deps, key, api: client(deps, home.cookie) };
  }

  it('refuses API requests without a valid Access token, even with a session', async () => {
    const { api, key } = await setup(true);
    expect((await api('/api/accounts')).status).toBe(403);
    expect((await api('/api/health')).status).toBe(403);
    const token = await key.sign(claims());
    expect((await api('/api/accounts', { headers: { 'cf-access-jwt-assertion': token } })).status).toBe(200);
  });

  it('still requires Wattle sign-in behind Access', async () => {
    const { deps, key } = await setup(true);
    const anonymous = client(deps);
    const response = await anonymous('/api/accounts', { headers: { 'cf-access-jwt-assertion': await key.sign(claims()) } });
    expect(response.status).toBe(401);
  });

  it('lets the Plaid webhook through to its own signature check', async () => {
    const { deps } = await setup(true);
    const response = await client(deps)('/api/plaid/webhook', { method: 'POST', body: '{}', headers: { origin: 'https://plaid.com' } });
    expect(response.status).toBe(503); // reached the route (no Plaid configured in this test)
  });

  it('does nothing when Access is not configured', async () => {
    const { api } = await setup(false);
    expect((await api('/api/accounts')).status).toBe(200);
    expect(certsRequests).toHaveLength(0);
  });
});
