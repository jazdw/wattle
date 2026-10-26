/**
 * The trust order (shared/quality.ts) as SQL, for upserts: a daily row is
 * replaced only by a write whose source is trusted at least as much.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { TRUST } from '../../shared/quality';

// Literals, not bound values: D1 allows 100 bound values per statement and the
// row chunks use them up.
const WHENS = Object.entries(TRUST)
  .map(([source, rank]) => `when '${source}' then ${rank}`)
  .join(' ');

function trustOf(expression: SQL | SQLiteColumn): SQL {
  return sql`(case ${expression} ${sql.raw(WHENS)} end)`;
}

/** For `onConflictDoUpdate`'s `setWhere`: the incoming row's source is trusted at least as much as the stored one's. */
export function replaceWhere(source: SQLiteColumn): SQL {
  return sql`${trustOf(sql.raw('excluded.source'))} >= ${trustOf(source)}`;
}

/** The quality columns of an upsert's `set`, taken from the incoming row. */
export const QUALITY_SET = {
  source: sql`excluded.source`,
  priceSource: sql`excluded.price_source`,
  unmatched: sql`excluded.unmatched`,
};
