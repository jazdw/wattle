import { eq, lt } from 'drizzle-orm';
import { kvCache } from '../db/schema';
import type { Deps } from '../ports';

/** Tiny TTL cache in the database (portable; no KV binding needed). Public data only. */
export async function cacheGet<T>(deps: Deps, key: string): Promise<T | null> {
  const [row] = await deps.db.select().from(kvCache).where(eq(kvCache.key, key));
  if (!row || row.expiresAt <= deps.now().getTime()) return null;
  return JSON.parse(row.value) as T;
}

export async function cacheSet(deps: Deps, key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const expiresAt = deps.now().getTime() + ttlSeconds * 1000;
  const json = JSON.stringify(value);
  await deps.db
    .insert(kvCache)
    .values({ key, value: json, expiresAt })
    .onConflictDoUpdate({ target: kvCache.key, set: { value: json, expiresAt } });
}

export async function cachePrune(deps: Deps): Promise<void> {
  await deps.db.delete(kvCache).where(lt(kvCache.expiresAt, deps.now().getTime()));
}
