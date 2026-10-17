/**
 * Google sign-in routes (the OAuth flow itself is in ./google) and DB-backed
 * sessions. Every user belongs to one household, chosen by the allow-list
 * entry they signed in with.
 */
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Context, MiddlewareHandler } from 'hono';
import type { AuthUser } from '../../shared/types';
import { allowedEmails, householdMembers, households, sessions, users } from '../db/schema';
import { Tenant } from '../db/tenant';
import type { AppEnv } from '../env';
import { finishSignIn, startSignIn, type PendingSignIn } from './google';
import { base64ToBytes, bytesToBase64Url, randomToken, sha256Hex } from '../lib/encoding';
import { stableId } from '../services/ids';
import type { Db, Deps } from '../ports';

export const SESSION_COOKIE = 'wt_session';
const OAUTH_COOKIE = 'wt_oauth';
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
  return row ? { householdId: row.householdId } : null;
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
    // Only safe while there is a single household: with several, an
    // allow-list entry must name one (npm run allow -- add … --household <id>).
    const existing = await deps.db
      .select({ id: households.id })
      .from(households)
      .orderBy(asc(households.createdAt))
      .limit(2);
    if (existing.length > 1) throw new AmbiguousHouseholdError();
    householdId = existing[0]?.id ?? null;
  }
  if (!householdId) {
    // The very first sign-in. A fixed id, so two people signing in for the
    // first time at the same moment both join one household (the second
    // insert is ignored) instead of creating two.
    householdId = await stableId('household:first');
    const created = await deps.db
      .insert(households)
      .values({ id: householdId, name: 'Our household', createdAt: now })
      .onConflictDoNothing()
      .returning({ id: households.id });
    if (created.length > 0) role = 'owner';
  }
  // A user belongs to one household (unique): a duplicate sign-in at the same
  // moment is ignored, and both read back the one membership.
  await deps.db.insert(householdMembers).values({ householdId, userId, role, createdAt: now }).onConflictDoNothing();
  const [membership] = await deps.db
    .select({ householdId: householdMembers.householdId })
    .from(householdMembers)
    .where(eq(householdMembers.userId, userId));
  return membership!.householdId;
}

class AmbiguousHouseholdError extends Error {
  constructor() {
    super('Allow-list entry must name a household when several exist.');
  }
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
  // One statement, so two sign-ins of the same person at once can't both insert.
  const [row] = await deps.db
    .insert(users)
    .values({ id: crypto.randomUUID(), googleSub: profile.sub, email: profile.email, name, picture, createdAt: now, lastLoginAt: now })
    .onConflictDoUpdate({ target: users.googleSub, set: { email: profile.email, name, picture, lastLoginAt: now } })
    .returning({ id: users.id });
  return row!.id;
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

authRoutes.get('/google', async (c) => {
  const { googleClientId } = c.env.deps.config;
  if (!googleClientId) {
    console.error('Google OAuth is not configured (GOOGLE_CLIENT_ID missing).');
    return c.redirect('/login?auth=config_error');
  }
  const { url, pending } = await startSignIn(googleClientId, c.req.url);
  setCookie(c, OAUTH_COOKIE, bytesToBase64Url(new TextEncoder().encode(JSON.stringify(pending))), {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isSecureRequest(c.req.url),
    path: '/api/auth',
    maxAge: 600,
  });
  return c.redirect(url.href);
});

function readPending(value: string | undefined): PendingSignIn | null {
  if (!value) return null;
  try {
    const pending = JSON.parse(new TextDecoder().decode(base64ToBytes(value))) as Partial<PendingSignIn>;
    return pending.state && pending.verifier && pending.nonce ? (pending as PendingSignIn) : null;
  } catch {
    return null;
  }
}

authRoutes.get('/google/callback', async (c) => {
  const { googleClientId, googleClientSecret } = c.env.deps.config;
  const pending = readPending(getCookie(c, OAUTH_COOKIE));
  deleteCookie(c, OAUTH_COOKIE, { path: '/api/auth' });

  if (!googleClientId || !googleClientSecret) return c.redirect('/login?auth=config_error');
  const state = new URL(c.req.url).searchParams.get('state');
  if (!pending || !state || state !== pending.state) return c.redirect('/login?auth=invalid_state');

  let profile;
  try {
    profile = await finishSignIn(googleClientId, googleClientSecret, c.req.url, pending);
  } catch (error) {
    console.warn('Google sign-in failed', error instanceof Error ? error.message : error);
    return c.redirect('/login?auth=token_error');
  }

  try {
    if (!profile.emailVerified) return c.redirect('/login?auth=email_unverified');
    const allowance = await findAllowance(c.env.deps, profile.email);
    if (!allowance) return c.redirect('/login?auth=not_allowed');

    await signIn(c, { sub: profile.sub, email: profile.email, name: profile.name, picture: profile.picture }, allowance);
    return c.redirect('/');
  } catch (error) {
    if (error instanceof AmbiguousHouseholdError) return c.redirect('/login?auth=not_allowed');
    console.error('OAuth callback failed', error instanceof Error ? error.message : error);
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
