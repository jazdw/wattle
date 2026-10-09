/** Test harness: the real app on in-memory SQLite (libsql) with fake providers. */
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createApp } from '../server/app';
import { createSession } from '../server/auth/routes';
import * as schema from '../server/db/schema';
import type { Deps, Db } from '../server/ports';

export const ORIGIN = 'http://localhost';
export const TEST_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, index) => index)));

/** D1's limit; libsql allows far more, so the test client enforces it. */
const D1_MAX_PARAMS = 100;

function checkParams(statement: unknown): void {
  const args = (statement as { args?: unknown[] | Record<string, unknown> })?.args;
  const count = Array.isArray(args) ? args.length : args ? Object.keys(args).length : 0;
  if (count > D1_MAX_PARAMS) throw new Error(`Statement binds ${count} parameters; D1 allows ${D1_MAX_PARAMS}.`);
}

export async function createTestDeps(overrides: Partial<Deps> = {}): Promise<Deps> {
  const client = createClient({ url: ':memory:' });
  const execute = client.execute.bind(client);
  const batch = client.batch.bind(client);
  client.execute = ((statement: Parameters<typeof execute>[0]) => {
    checkParams(statement);
    return execute(statement);
  }) as typeof client.execute;
  client.batch = ((statements: Parameters<typeof batch>[0], mode?: Parameters<typeof batch>[1]) => {
    for (const statement of statements) checkParams(statement);
    return batch(statements, mode);
  }) as typeof client.batch;
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: 'migrations' });
  const pending: Promise<unknown>[] = [];
  const deps: Deps = {
    db: db as unknown as Db,
    config: { allowedEmails: [], devLoginEmails: [], tokenEncKey: TEST_KEY, adminToken: 'admin-secret' },
    plaid: null,
    prices: null,
    quotes: null,
    fx: null,
    now: () => new Date('2026-10-09T02:00:00Z'),
    background: (work) => {
      pending.push(work);
    },
    ...overrides,
  };
  pendingWork.set(deps, pending);
  return deps;
}

const pendingWork = new WeakMap<Deps, Promise<unknown>[]>();

/** Wait for work handed to `deps.background` (post-link backfills, webhook syncs). */
export async function flush(deps: Deps): Promise<void> {
  const pending = pendingWork.get(deps) ?? [];
  while (pending.length > 0) await pending.shift();
}

/** Today's market date for the fixed test clock (2026-10-08 in New York). */
export const TODAY = '2026-10-08';

export async function createHousehold(deps: Deps, name: string, email: string) {
  const householdId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const now = Date.now();
  await deps.db.insert(schema.households).values({ id: householdId, name, createdAt: now });
  await deps.db.insert(schema.users).values({ id: userId, googleSub: `sub-${userId}`, email, name: email, createdAt: now });
  await deps.db.insert(schema.householdMembers).values({ householdId, userId, role: 'owner', createdAt: now });
  const token = await createSession(deps, userId);
  return { householdId, userId, cookie: `wt_session=${token}` };
}

export interface TestResponse {
  status: number;
  // oxlint-disable-next-line typescript/no-explicit-any -- test convenience
  body: any;
  headers: Headers;
}

/**
 * Calls the real app as a browser on ORIGIN would: same-origin `Origin` on
 * writes (override with `headers`), optional session cookie, JSON bodies.
 */
export function client(deps: Deps, cookie?: string, origin = ORIGIN) {
  const app = createApp();
  return async (path: string, init: RequestInit & { json?: unknown } = {}): Promise<TestResponse> => {
    const headers = new Headers(init.headers);
    if (cookie && !headers.has('cookie')) headers.set('cookie', cookie);
    let body = init.body;
    if (init.json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(init.json);
    }
    if (init.method && init.method !== 'GET' && !headers.has('origin')) headers.set('origin', origin);
    const response = await app.request(`${origin}${path}`, { ...init, headers, body }, { deps });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed, headers: response.headers };
  };
}
