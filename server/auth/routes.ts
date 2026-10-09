/**
 * Google OAuth sign-in (authorization-code flow, no library) and DB-backed
 * sessions. Ported from WingPoint, with households: every user belongs to one
 * household, chosen by the allow-list entry they signed in with.
 */
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Context, MiddlewareHandler } from 'hono';
import type { AuthUser } from '../../shared/types';
import { allowedEmails, householdMembers, households, sessions, users } from '../db/schema';
import { Tenant } from '../db/tenant';
import type { AppEnv } from '../env';
import { randomToken, sha256Hex } from '../lib/encoding';
import type { Db, Deps } from '../ports';

export const SESSION_COOKIE = 'wt_session';
const OAUTH_STATE_COOKIE = 'wt_oauth_state';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function isSecureRequest(url: string): boolean {
  return new URL(url).protocol === 'https:';
}

/**
 * Whether a host is local or on a private network. Used only to gate the
 * development sign-in so it works from a phone on the same LAN but never on a
 * public hostname.
 */
export function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (host.endsWith('.local')) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

export async function createSession(deps: Deps, userId: string): Promise<string> {
  const token = randomToken();
  const now = deps.now().getTime();
  await deps.db.insert(sessions).values({
    id: await sha256Hex(token),
    userId,
    createdAt: now,
    expiresAt: now + SESSION_TTL_SECONDS * 1000,
  });
  return token;
}

async function destroySession(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, await sha256Hex(token)));
}

async function getSessionUser(deps: Deps, token: string): Promise<AuthUser | null> {
  const [row] = await deps.db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      picture: users.picture,
      householdId: householdMembers.householdId,
      role: householdMembers.role,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(householdMembers, eq(householdMembers.userId, users.id))
    .where(and(eq(sessions.id, await sha256Hex(token)), gt(sessions.expiresAt, deps.now().getTime())))
    .limit(1);
  return row ?? null;
}

function setSessionCookie(c: Context<AppEnv>, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isSecureRequest(c.req.url),
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

/* ------------------------------------------------------------------ */
/* Allow-list & households                                             */
/* ------------------------------------------------------------------ */

interface Allowance {
  /** Household named by the allow-list row; null = the default household. */
  householdId: string | null;
}

export async function findAllowance(deps: Deps, email: string): Promise<Allowance | null> {
  const normalized = email.trim().toLowerCase();
  const [row] = await deps.db
    .select({ householdId: allowedEmails.householdId })
    .from(allowedEmails)
    .where(eq(sql`lower(${allowedEmails.email})`, normalized))
    .limit(1);
  if (row) return { householdId: row.householdId };
  if (deps.config.allowedEmails.includes(normalized)) return { householdId: null };
  return null;
}

/**
 * The household a user belongs to, joining one on first sign-in. Users
 * without an explicit household join the oldest household (created on the
 * very first sign-in) — the single-tenant setup.
 */
async function ensureMembership(deps: Deps, userId: string, allowance: Allowance): Promise<string> {
  const [existing] = await deps.db
    .select({ householdId: householdMembers.householdId })
    .from(householdMembers)
    .where(eq(householdMembers.userId, userId))
    .limit(1);
  if (existing) return existing.householdId;

  const now = deps.now().getTime();
  let householdId = allowance.householdId;
  let role: 'owner' | 'member' = 'member';
  if (!householdId) {
    const [first] = await deps.db
      .select({ id: households.id })
      .from(households)
      .orderBy(asc(households.createdAt))
      .limit(1);
    householdId = first?.id ?? null;
  }
  if (!householdId) {
    householdId = crypto.randomUUID();
    role = 'owner';
    await deps.db.insert(households).values({ id: householdId, name: 'Our household', createdAt: now });
  }
  await deps.db.insert(householdMembers).values({ householdId, userId, role, createdAt: now });
  return householdId;
}

interface UserProfile {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
}

async function upsertUser(deps: Deps, profile: UserProfile): Promise<string> {
  const now = deps.now().getTime();
  const name = profile.name ?? profile.email;
  const picture = profile.picture ?? null;
  const [existing] = await deps.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.googleSub, profile.sub))
    .limit(1);
  if (existing) {
    await deps.db
      .update(users)
      .set({ email: profile.email, name, picture, lastLoginAt: now })
      .where(eq(users.id, existing.id));
    return existing.id;
  }
  const id = crypto.randomUUID();
  await deps.db.insert(users).values({
    id,
    googleSub: profile.sub,
    email: profile.email,
    name,
    picture,
    createdAt: now,
    lastLoginAt: now,
  });
  return id;
}

async function signIn(c: Context<AppEnv>, profile: UserProfile, allowance: Allowance): Promise<void> {
  const deps = c.env.deps;
  const userId = await upsertUser(deps, profile);
  await ensureMembership(deps, userId, allowance);
  setSessionCookie(c, await createSession(deps, userId));
}

/* ------------------------------------------------------------------ */
/* Middleware                                                          */
/* ------------------------------------------------------------------ */

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return c.json({ error: 'unauthenticated' }, 401);

  const user = await getSessionUser(c.env.deps, token);
  if (!user) {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ error: 'unauthenticated' }, 401);
  }

  c.set('user', user);
  c.set('tenant', new Tenant(c.env.deps.db, user.householdId));
  await next();
};

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export const authRoutes = new Hono<AppEnv>();

authRoutes.get('/google', (c) => {
  const { googleClientId } = c.env.deps.config;
  if (!googleClientId) {
    console.error('Google OAuth is not configured (GOOGLE_CLIENT_ID missing).');
    return c.redirect('/login?auth=config_error');
  }

  const state = randomToken(16);
  setCookie(c, OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isSecureRequest(c.req.url),
    path: '/',
    maxAge: 600,
  });

  const params = new URLSearchParams({
    client_id: googleClientId,
    redirect_uri: `${new URL(c.req.url).origin}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
    state,
  });
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

authRoutes.get('/google/callback', async (c) => {
  const { googleClientId, googleClientSecret } = c.env.deps.config;
  const url = new URL(c.req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expectedState = getCookie(c, OAUTH_STATE_COOKIE);
  deleteCookie(c, OAUTH_STATE_COOKIE, { path: '/' });

  if (!googleClientId || !googleClientSecret) return c.redirect('/login?auth=config_error');
  if (!code || !state || !expectedState || state !== expectedState) {
    return c.redirect('/login?auth=invalid_state');
  }

  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: googleClientId,
        client_secret: googleClientSecret,
        redirect_uri: `${url.origin}/api/auth/google/callback`,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenResponse.ok) return c.redirect('/login?auth=token_error');
    const tokens = (await tokenResponse.json()) as { access_token?: string };
    if (!tokens.access_token) return c.redirect('/login?auth=token_error');

    const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    if (!profileResponse.ok) return c.redirect('/login?auth=profile_error');
    const profile = (await profileResponse.json()) as {
      sub?: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
      picture?: string;
    };

    if (!profile.sub || !profile.email) return c.redirect('/login?auth=profile_error');
    if (profile.email_verified !== true) return c.redirect('/login?auth=email_unverified');
    const allowance = await findAllowance(c.env.deps, profile.email);
    if (!allowance) return c.redirect('/login?auth=not_allowed');

    await signIn(
      c,
      { sub: profile.sub, email: profile.email, name: profile.name, picture: profile.picture },
      allowance,
    );
    return c.redirect('/');
  } catch (error) {
    console.error('OAuth callback failed', error);
    return c.redirect('/login?auth=oauth_failed');
  }
});

authRoutes.get('/me', requireAuth, async (c) => {
  const tenant = c.get('tenant');
  const [household] = await tenant.db
    .select({ id: households.id, name: households.name, displayCurrency: households.displayCurrency })
    .from(households)
    .where(eq(households.id, tenant.householdId));
  const members = await tenant.db
    .select({ id: users.id, name: users.name, email: users.email, picture: users.picture })
    .from(householdMembers)
    .innerJoin(users, eq(users.id, householdMembers.userId))
    .where(eq(householdMembers.householdId, tenant.householdId))
    .orderBy(asc(householdMembers.createdAt));
  return c.json({ user: c.get('user'), household: { ...household, members } });
});

authRoutes.post('/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await destroySession(c.env.deps.db, token);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

function devDisplayName(email: string): string {
  const local = email.split('@')[0] ?? email;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

/** The dev accounts available to sign in as (only on a local/private host). */
authRoutes.get('/dev-users', (c) => {
  if (!isPrivateHost(new URL(c.req.url).hostname)) return c.json({ users: [] });
  return c.json({
    users: c.env.deps.config.devLoginEmails.map((email) => ({ email, name: devDisplayName(email) })),
  });
});

/**
 * Local-development sign-in. Only works for a configured dev email and when
 * the request is made to a local/private host, so it can never be used in
 * production.
 */
authRoutes.get('/dev', async (c) => {
  const allowed = c.env.deps.config.devLoginEmails;
  const email = c.req.query('email')?.trim().toLowerCase() ?? allowed[0];
  if (!email || !isPrivateHost(new URL(c.req.url).hostname) || !allowed.includes(email)) {
    return c.json({ error: 'Dev sign-in is disabled.' }, 403);
  }
  await signIn(c, { sub: `dev:${email}`, email, name: devDisplayName(email) }, { householdId: null });
  return c.redirect('/');
});
