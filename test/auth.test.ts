import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../server/db/schema';
import type { Deps } from '../server/ports';
import { client, createHousehold, createTestDeps } from './helpers';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** The nonce Google would echo: taken from the sign-in URL Wattle built. */
let currentNonce = '';
/** Token requests Wattle made (to check PKCE). */
let tokenRequests: URLSearchParams[] = [];

/**
 * Stub Google's token endpoint. It answers with an ID token carrying
 * `claims`, issued for client "gid" and the current sign-in's nonce
 * (overridable per test).
 */
function stubGoogle(claims: Record<string, unknown>, options: { tokenOk?: boolean } = {}) {
  tokenRequests = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const body = input instanceof Request ? await input.text() : String(init?.body ?? '');
      tokenRequests.push(new URLSearchParams(body));
      if (options.tokenOk === false) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      const now = Math.floor(Date.now() / 1000);
      const idToken = [
        encode({ alg: 'RS256', typ: 'JWT', kid: 'test' }),
        encode({ iss: 'https://accounts.google.com', aud: 'gid', iat: now, exp: now + 3600, nonce: currentNonce, ...claims }),
        'c2lnbmF0dXJl', // not checked: the token comes straight from Google over TLS
      ].join('.');
      return Response.json({ access_token: 'google-access', token_type: 'Bearer', expires_in: 3600, id_token: idToken });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Deps with Google configured and `allowed` on the allow-list (joining the default household). */
async function configured(allowed: string[] = []) {
  const deps = await createTestDeps();
  deps.config = { ...deps.config, googleClientId: 'gid', googleClientSecret: 'gsecret' };
  if (allowed.length) await deps.db.insert(schema.allowedEmails).values(allowed.map((email) => ({ email, addedAt: 0 })));
  return deps;
}

/** Start the flow, then call back with Google's code and the issued state. */
async function signInWithGoogle(deps: Deps) {
  const api = client(deps);
  const start = await api('/api/auth/google');
  const location = new URL(start.headers.get('location')!);
  const state = location.searchParams.get('state')!;
  currentNonce = location.searchParams.get('nonce')!;
  const pendingCookie = start.headers.get('set-cookie')!.split(';')[0];
  const callback = await api(`/api/auth/google/callback?code=abc&state=${state}`, { headers: { cookie: pendingCookie } });
  return { start, location, callback };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Google sign-in', () => {
  it('redirects to Google with a state cookie and the origin-derived callback', async () => {
    const deps = await configured();
    const response = await client(deps)('/api/auth/google');
    const url = new URL(response.headers.get('location')!);
    expect(response.status).toBe(302);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost/api/auth/google/callback');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(response.headers.get('set-cookie')).toMatch(/wt_oauth=.*HttpOnly/i);
  });

  it('reports a missing configuration', async () => {
    const deps = await createTestDeps();
    const response = await client(deps)('/api/auth/google');
    expect(response.headers.get('location')).toBe('/login?auth=config_error');
  });

  it('rejects a callback whose state does not match', async () => {
    const deps = await configured();
    const start = await client(deps)('/api/auth/google');
    const pendingCookie = start.headers.get('set-cookie')!.split(';')[0];
    const response = await client(deps)('/api/auth/google/callback?code=abc&state=forged', { headers: { cookie: pendingCookie } });
    expect(response.headers.get('location')).toBe('/login?auth=invalid_state');
    const noCookie = await client(deps)('/api/auth/google/callback?code=abc&state=forged');
    expect(noCookie.headers.get('location')).toBe('/login?auth=invalid_state');
  });

  it('sends the PKCE verifier with the code exchange', async () => {
    const deps = await configured(['me@example.com']);
    stubGoogle({ sub: 's-me', email: 'me@example.com', email_verified: true });
    const { location, callback } = await signInWithGoogle(deps);
    expect(callback.headers.get('location')).toBe('/');
    const [request] = tokenRequests;
    expect(request.get('code')).toBe('abc');
    expect(request.get('redirect_uri')).toBe('http://localhost/api/auth/google/callback');
    // The verifier hashes to the challenge sent to Google at the start.
    const verifier = request.get('code_verifier')!;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    expect(Buffer.from(digest).toString('base64url')).toBe(location.searchParams.get('code_challenge'));
  });

  it('rejects ID tokens for another app or another sign-in', async () => {
    const deps = await configured(['me@example.com']);
    stubGoogle({ sub: 's-me', email: 'me@example.com', email_verified: true, aud: 'someone-elses-client' });
    expect((await signInWithGoogle(deps)).callback.headers.get('location')).toBe('/login?auth=token_error');
    stubGoogle({ sub: 's-me', email: 'me@example.com', email_verified: true, nonce: 'replayed' });
    expect((await signInWithGoogle(deps)).callback.headers.get('location')).toBe('/login?auth=token_error');
    stubGoogle({ sub: 's-me', email: 'me@example.com', email_verified: true, iss: 'https://evil.example' });
    expect((await signInWithGoogle(deps)).callback.headers.get('location')).toBe('/login?auth=token_error');
    expect(await deps.db.select().from(schema.users)).toHaveLength(0);
  });

  it('refuses emails that are not allowed', async () => {
    const deps = await configured();
    stubGoogle({ sub: 's1', email: 'stranger@example.com', email_verified: true });
    const { callback } = await signInWithGoogle(deps);
    expect(callback.headers.get('location')).toBe('/login?auth=not_allowed');
    expect(await deps.db.select().from(schema.users)).toHaveLength(0);
  });

  it('refuses unverified emails and Google errors', async () => {
    const deps = await configured(['me@example.com']);
    stubGoogle({ sub: 's1', email: 'me@example.com', email_verified: false });
    expect((await signInWithGoogle(deps)).callback.headers.get('location')).toBe('/login?auth=email_unverified');

    stubGoogle({}, { tokenOk: false });
    expect((await signInWithGoogle(deps)).callback.headers.get('location')).toBe('/login?auth=token_error');
  });

  it('creates the first household for the first allowed user, and the partner joins it', async () => {
    const deps = await configured(['me@example.com', 'partner@example.com']);
    stubGoogle({ sub: 's-me', email: 'me@example.com', email_verified: true, name: 'Me' });
    const first = (await signInWithGoogle(deps)).callback;
    expect(first.headers.get('location')).toBe('/');
    const cookie = first.headers.get('set-cookie')!.match(/wt_session=[^;]+/)![0];

    const later = new Date(deps.now().getTime() + 60_000);
    deps.now = () => later;
    stubGoogle({ sub: 's-partner', email: 'partner@example.com', email_verified: true, name: 'Partner' });
    await signInWithGoogle(deps);

    const households = await deps.db.select().from(schema.households);
    expect(households).toHaveLength(1);
    const members = await deps.db.select().from(schema.householdMembers);
    expect(members.map((member) => member.role).sort()).toEqual(['member', 'owner']);

    const me = await client(deps, cookie)('/api/auth/me');
    expect(me.body.household.members.map((member: { name: string }) => member.name)).toEqual(['Me', 'Partner']);
  });

  it('puts a user in the household named by their allow-list entry', async () => {
    const deps = await configured();
    const other = await createHousehold(deps, 'Other', 'owner@example.com');
    await deps.db.insert(schema.allowedEmails).values({ email: 'Guest@Example.com', householdId: other.householdId, addedAt: 0 });
    stubGoogle({ sub: 's-guest', email: 'guest@example.com', email_verified: true });
    await signInWithGoogle(deps);
    const [guest] = await deps.db.select().from(schema.users).where(eq(schema.users.email, 'guest@example.com'));
    const [membership] = await deps.db.select().from(schema.householdMembers).where(eq(schema.householdMembers.userId, guest.id));
    expect(membership.householdId).toBe(other.householdId);
  });

  it('updates the profile on later sign-ins', async () => {
    const deps = await configured(['me@example.com']);
    stubGoogle({ sub: 's-me', email: 'me@example.com', email_verified: true, name: 'Old' });
    await signInWithGoogle(deps);
    stubGoogle({ sub: 's-me', email: 'me@example.com', email_verified: true, name: 'New' });
    await signInWithGoogle(deps);
    const users = await deps.db.select().from(schema.users);
    expect(users).toHaveLength(1);
    expect(users[0].name).toBe('New');
  });
});

describe('sessions', () => {
  it('signs out and rejects the old cookie', async () => {
    const deps = await createTestDeps();
    const home = await createHousehold(deps, 'Home', 'me@example.com');
    const api = client(deps, home.cookie);
    expect((await api('/api/auth/me')).status).toBe(200);
    expect((await api('/api/auth/logout', { method: 'POST' })).status).toBe(200);
    const after = await api('/api/auth/me');
    expect(after.status).toBe(401);
  });

  it('expires sessions after 30 days', async () => {
    const deps = await createTestDeps();
    const home = await createHousehold(deps, 'Home', 'me@example.com');
    const later = new Date(deps.now().getTime() + 31 * 24 * 3600 * 1000);
    deps.now = () => later;
    const response = await client(deps, home.cookie)('/api/auth/me');
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toMatch(/wt_session=;/);
  });

  it('rejects unknown session tokens', async () => {
    const deps = await createTestDeps();
    expect((await client(deps, 'wt_session=nonsense')('/api/accounts')).status).toBe(401);
  });
});

describe('dev sign-in', () => {
  it('works only on a private host for configured emails', async () => {
    const deps = await createTestDeps();
    deps.config.devLoginEmails = ['dev@example.com'];

    const local = client(deps);
    expect((await local('/api/auth/dev-users')).body.users).toEqual([{ email: 'dev@example.com', name: 'Dev' }]);
    const ok = await local('/api/auth/dev?email=dev@example.com');
    expect(ok.status).toBe(302);
    expect(ok.headers.get('set-cookie')).toMatch(/wt_session=/);
    expect((await local('/api/auth/dev?email=other@example.com')).status).toBe(403);

    const publicHost = client(deps, undefined, 'https://wattle.example.com');
    expect((await publicHost('/api/auth/dev-users')).body.users).toEqual([]);
    expect((await publicHost('/api/auth/dev?email=dev@example.com')).status).toBe(403);
  });
});

describe('household safety', () => {
  it('refuses to guess a household once several exist', async () => {
    const deps = await configured(['loose@example.com']);
    await createHousehold(deps, 'One', 'one@example.com');
    await createHousehold(deps, 'Two', 'two@example.com');
    stubGoogle({ sub: 's-loose', email: 'loose@example.com', email_verified: true });
    const { callback } = await signInWithGoogle(deps);
    expect(callback.headers.get('location')).toBe('/login?auth=not_allowed');
    const users = await deps.db.select().from(schema.users).where(eq(schema.users.email, 'loose@example.com'));
    const memberships = await deps.db.select().from(schema.householdMembers).where(eq(schema.householdMembers.userId, users[0]?.id ?? ''));
    expect(memberships).toHaveLength(0);
  });

  it('prunes expired sessions in the daily job', async () => {
    const { runDaily } = await import('../server/services/jobs');
    const deps = await createTestDeps();
    await createHousehold(deps, 'Home', 'me@example.com');
    const later = new Date(deps.now().getTime() + 31 * 24 * 3600 * 1000);
    deps.now = () => later;
    await runDaily(deps);
    expect(await deps.db.select().from(schema.sessions)).toHaveLength(0);
  });
});
