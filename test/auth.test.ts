import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../server/db/schema';
import type { Deps } from '../server/ports';
import { client, createHousehold, createTestDeps } from './helpers';

/** Stub Google's token + userinfo endpoints. */
function stubGoogle(profile: Record<string, unknown>, options: { tokenOk?: boolean; profileOk?: boolean } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return options.tokenOk === false
        ? new Response('{}', { status: 400 })
        : Response.json({ access_token: 'google-access' });
    }
    if (url.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) {
      return options.profileOk === false ? new Response('', { status: 500 }) : Response.json(profile);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function configured(overrides: Partial<Deps['config']> = {}) {
  const deps = await createTestDeps();
  deps.config = { ...deps.config, googleClientId: 'gid', googleClientSecret: 'gsecret', ...overrides };
  return deps;
}

/** Start the flow, then call back with Google's code and the issued state. */
async function signInWithGoogle(deps: Deps) {
  const api = client(deps);
  const start = await api('/api/auth/google');
  const location = new URL(start.headers.get('location')!);
  const state = location.searchParams.get('state')!;
  const stateCookie = start.headers.get('set-cookie')!.split(';')[0];
  const callback = await api(`/api/auth/google/callback?code=abc&state=${state}`, { headers: { cookie: stateCookie } });
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
    expect(url.searchParams.get('state')).toHaveLength(32);
    expect(response.headers.get('set-cookie')).toMatch(/wt_oauth_state=.*HttpOnly/i);
  });

  it('reports a missing configuration', async () => {
    const deps = await createTestDeps();
    const response = await client(deps)('/api/auth/google');
    expect(response.headers.get('location')).toBe('/login?auth=config_error');
  });

  it('rejects a callback whose state does not match', async () => {
    const deps = await configured();
    const response = await client(deps)('/api/auth/google/callback?code=abc&state=forged', {
      headers: { cookie: 'wt_oauth_state=real' },
    });
    expect(response.headers.get('location')).toBe('/login?auth=invalid_state');
  });

  it('refuses emails that are not allowed', async () => {
    const deps = await configured();
    stubGoogle({ sub: 's1', email: 'stranger@example.com', email_verified: true });
    const { callback } = await signInWithGoogle(deps);
    expect(callback.headers.get('location')).toBe('/login?auth=not_allowed');
    expect(await deps.db.select().from(schema.users)).toHaveLength(0);
  });

  it('refuses unverified emails and Google errors', async () => {
    const deps = await configured({ allowedEmails: ['me@example.com'] });
    stubGoogle({ sub: 's1', email: 'me@example.com', email_verified: false });
    expect((await signInWithGoogle(deps)).callback.headers.get('location')).toBe('/login?auth=email_unverified');

    stubGoogle({}, { tokenOk: false });
    expect((await signInWithGoogle(deps)).callback.headers.get('location')).toBe('/login?auth=token_error');

    stubGoogle({}, { profileOk: false });
    expect((await signInWithGoogle(deps)).callback.headers.get('location')).toBe('/login?auth=profile_error');
  });

  it('creates the first household for the first allowed user, and the partner joins it', async () => {
    const deps = await configured({ allowedEmails: ['me@example.com', 'partner@example.com'] });
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
    const deps = await configured({ allowedEmails: ['me@example.com'] });
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
    const deps = await configured({ allowedEmails: ['loose@example.com'] });
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
