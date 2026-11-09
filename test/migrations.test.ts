/**
 * Migrations that move data: applied in order to a database holding rows in
 * the old shape, they keep every row.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createClient, type Client } from '@libsql/client';
import { describe, expect, it } from 'vitest';

const files = readdirSync('migrations')
  .filter((name) => name.endsWith('.sql'))
  .sort();

async function apply(client: Client, name: string) {
  for (const statement of readFileSync(`migrations/${name}`, 'utf8').split('--> statement-breakpoint')) {
    if (statement.trim()) await client.execute(statement);
  }
}

describe('migrations', () => {
  it('0004 moves Plaid investment and bank report transactions into one table and drops the old ones', async () => {
    const client = createClient({ url: ':memory:' });
    await client.execute('PRAGMA foreign_keys = ON');
    for (const name of files.filter((file) => file < '0004')) await apply(client, name);
    await client.execute("INSERT INTO households (id, name, display_currency, created_at) VALUES ('h1', 'Example', 'USD', 1)");
    await client.execute("INSERT INTO accounts (id, household_id, source, name, type, currency, created_at) VALUES ('brk', 'h1', 'manual', 'Brokerage', 'investment', 'USD', 1), ('chk', 'h1', 'manual', 'Checking', 'depository', 'USD', 1)");
    await client.execute(
      "INSERT INTO investment_transactions (id, household_id, account_id, external_id, date, name, type, subtype, quantity, amount, price, fees, currency) VALUES ('i1', 'h1', 'brk', 'plaid-1', '2026-03-02', 'Dividend', 'cash', 'dividend', 0, -1250, NULL, NULL, 'USD'), ('i2', 'h1', 'brk', 'plaid-2', '2026-03-03', 'Buy', 'buy', 'buy', 10, 60250, 60.25, 0, 'USD')",
    );
    await client.execute("INSERT INTO bank_transactions (id, household_id, account_id, external_id, date, amount, currency, description, created_at) VALUES ('b1', 'h1', 'chk', 'bank-1', '2026-03-04', 50000, 'USD', 'Transfer out', 7)");

    for (const name of files.filter((file) => file >= '0004')) await apply(client, name);

    const rows = (await client.execute('SELECT id, source, external_id, date, amount, type, subtype, description, quantity, price, kind FROM transactions ORDER BY id')).rows.map((row) => ({ ...row }));
    expect(rows).toEqual([
      { id: 'b1', source: 'report', external_id: 'bank-1', date: '2026-03-04', amount: 50000, type: null, subtype: null, description: 'Transfer out', quantity: 0, price: null, kind: null },
      { id: 'i1', source: 'plaid', external_id: 'plaid-1', date: '2026-03-02', amount: -1250, type: 'cash', subtype: 'dividend', description: 'Dividend', quantity: 0, price: null, kind: null },
      { id: 'i2', source: 'plaid', external_id: 'plaid-2', date: '2026-03-03', amount: 60250, type: 'buy', subtype: 'buy', description: 'Buy', quantity: 10, price: 60.25, kind: null },
    ]);
    const tables = (await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%transactions'")).rows.map((row) => row.name);
    expect(tables).toEqual(['transactions']);
  });
});
