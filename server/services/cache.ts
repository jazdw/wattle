import { and, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { chunkRows, inChunks, runBatch } from '../db/batch';
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

/** Several keys in one query; missing or expired keys are absent from the map. */
export async function cacheGetMany<T>(deps: Deps, keys: string[]): Promise<Map<string, T>> {
  const found = new Map<string, T>();
  if (keys.length === 0) return found;
  for (const chunk of inChunks(keys)) {
    const rows = await deps.db
      .select()
      .from(kvCache)
      .where(and(inArray(kvCache.key, chunk), gt(kvCache.expiresAt, deps.now().getTime())));
    for (const row of rows) found.set(row.key, JSON.parse(row.value) as T);
  }
  return found;
}

/** Several entries in one batch. */
export async function cacheSetMany(deps: Deps, entries: [key: string, value: unknown][], ttlSeconds: number): Promise<void> {
  if (entries.length === 0) return;
  const expiresAt = deps.now().getTime() + ttlSeconds * 1000;
  const rows = entries.map(([key, value]) => ({ key, value: JSON.stringify(value), expiresAt }));
  await runBatch(
    deps.db,
    chunkRows(kvCache, rows).map((chunk) =>
      deps.db
        .insert(kvCache)
        .values(chunk)
        .onConflictDoUpdate({ target: kvCache.key, set: { value: sql`excluded.value`, expiresAt: sql`excluded.expires_at` } }),
    ),
  );
}
