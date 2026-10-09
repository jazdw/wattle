import { getTableColumns, isTable } from 'drizzle-orm';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import * as schema from '../server/db/schema';

const tables = Object.values(schema).filter((value) => isTable(value)) as SQLiteTable[];

describe('schema', () => {
  it('never stores account or routing numbers', () => {
    for (const table of tables) {
      for (const column of Object.values(getTableColumns(table))) {
        expect(column.name).not.toMatch(/account_?num|routing|iban|bsb|card_?num/i);
      }
    }
  });

  it('scopes every household data table by household_id', () => {
    const global = new Set(['households', 'users', 'sessions', 'allowed_emails', 'prices_daily', 'fx_daily', 'kv_cache', 'household_members']);
    for (const table of tables) {
      const { name, columns } = getTableConfig(table);
      if (global.has(name)) continue;
      expect(columns.map((column) => column.name), name).toContain('household_id');
    }
  });
});
