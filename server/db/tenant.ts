import { and, eq, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { Db } from '../ports';

/**
 * The household a request (or job) acts for. Route handlers and services only
 * reach household data through a Tenant: every read uses `scope(table, …)`,
 * which always adds `household_id = ?`, and every insert takes its
 * `householdId` from here. test/tenancy.test.ts checks that no route leaks
 * data between households.
 */
export class Tenant {
  readonly db: Db;
  readonly householdId: string;

  constructor(db: Db, householdId: string) {
    this.db = db;
    this.householdId = householdId;
  }

  scope(table: { householdId: SQLiteColumn }, ...conditions: (SQL | undefined)[]): SQL {
    return and(eq(table.householdId, this.householdId), ...conditions)!;
  }
}
