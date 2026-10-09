import { getTableColumns } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { Db } from '../ports';

/** D1 allows at most 100 bound parameters per statement. */
const MAX_PARAMS = 100;
const STATEMENTS_PER_BATCH = 50;

/**
 * Split rows so each multi-row INSERT stays under D1's parameter limit.
 * Counts every column of the table: Drizzle binds schema defaults for columns
 * a row leaves out.
 */
export function chunkRows<T extends object>(table: SQLiteTable, rows: T[]): T[][] {
  if (rows.length === 0) return [];
  const columns = Math.max(1, Object.keys(getTableColumns(table)).length);
  const size = Math.max(1, Math.floor(MAX_PARAMS / columns));
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) chunks.push(rows.slice(index, index + size));
  return chunks;
}

/**
 * Run statements in transactional batches (D1 and libsql both support
 * `db.batch`, which BaseSQLiteDatabase doesn't declare).
 */
export async function runBatch(db: Db, statements: BatchItem<'sqlite'>[]): Promise<void> {
  const batcher = db as unknown as { batch(items: BatchItem<'sqlite'>[]): Promise<unknown> };
  for (let index = 0; index < statements.length; index += STATEMENTS_PER_BATCH) {
    const slice = statements.slice(index, index + STATEMENTS_PER_BATCH);
    if (slice.length > 0) await batcher.batch(slice);
  }
}
