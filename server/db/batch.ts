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
 * Run statements as ONE batch: a transaction on D1 and libsql, so either every
 * statement applies or none does. D1 documents no limit on statements per
 * batch, only per statement (100 parameters, 100 KB) and 30 s per batch.
 */
export async function runAtomic(db: Db, statements: BatchItem<'sqlite'>[]): Promise<void> {
  if (statements.length === 0) return;
  const batcher = db as unknown as { batch(items: BatchItem<'sqlite'>[]): Promise<unknown> };
  await batcher.batch(statements);
}

/**
 * Run statements in batches of up to 50 (D1 and libsql both support
 * `db.batch`, which BaseSQLiteDatabase doesn't declare). Each batch is a
 * transaction, but together they're not: use this only for idempotent bulk
 * writes such as history backfills, and runAtomic for anything else.
 */
export async function runBatch(db: Db, statements: BatchItem<'sqlite'>[]): Promise<void> {
  const batcher = db as unknown as { batch(items: BatchItem<'sqlite'>[]): Promise<unknown> };
  for (let index = 0; index < statements.length; index += STATEMENTS_PER_BATCH) {
    const slice = statements.slice(index, index + STATEMENTS_PER_BATCH);
    if (slice.length > 0) await batcher.batch(slice);
  }
}

/** Split values for `IN (...)` lists so each query stays under D1's parameter limit. */
export function inChunks<T>(values: T[], size = 90): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}
