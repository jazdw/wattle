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

  it('0006 records the days the transactions already stored cover: runs of imported days, bank reports from their replies, Plaid investments to their latest synced day', async () => {
    const client = createClient({ url: ':memory:' });
    await client.execute('PRAGMA foreign_keys = ON');
    for (const name of files.filter((file) => file < '0006')) await apply(client, name);
    await client.execute("INSERT INTO households (id, name, display_currency, created_at) VALUES ('h1', 'Example', 'USD', 1)");
    await client.execute("INSERT INTO connections (id, household_id, external_id, access_token_enc, kind, has_investments, created_at) VALUES ('c1', 'h1', 'item-1', 'x', 'account', 1, 1)");
    await client.execute(
      "INSERT INTO accounts (id, household_id, source, connection_id, external_id, name, type, currency, created_at) VALUES ('card', 'h1', 'manual', NULL, NULL, 'Card', 'credit', 'USD', 1), ('chk', 'h1', 'plaid', 'c1', 'ext-chk', 'Checking', 'depository', 'USD', 1), ('sav', 'h1', 'plaid', 'c1', 'ext-sav', 'Savings', 'depository', 'USD', 1), ('brk', 'h1', 'plaid', 'c1', 'ext-brk', 'Brokerage', 'investment', 'USD', 1)",
    );
    const days = (account: string, source: string, dates: string[]) => dates.map((date) => `('h1', '${account}', '${date}', 0, 'USD', '${source}')`).join(', ');
    await client.execute(
      `INSERT INTO account_daily (household_id, account_id, date, balance, currency, source) VALUES ${days('card', 'import', ['2025-12-01', '2025-12-02', '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-05', '2026-01-06'])}, ${days('brk', 'snapshot', ['2026-10-07', '2026-10-08'])}`,
    );
    const txn = (id: string, account: string, source: string, date: string) => `('${id}', 'h1', '${account}', '${source}', '${id}', '${date}', 'USD', 1)`;
    await client.execute(
      `INSERT INTO transactions (id, household_id, account_id, source, external_id, date, currency, created_at) VALUES ${[
        // The card's imports: two runs of days with transactions; December's has none (an older import), so isn't covered.
        txn('i1', 'card', 'import', '2026-01-02'),
        txn('i2', 'card', 'import', '2026-01-05'),
        txn('r1', 'chk', 'report', '2026-10-02'),
        // No reply kept for the savings account's report.
        txn('r2', 'sav', 'report', '2026-09-15'),
        txn('r3', 'sav', 'report', '2026-10-01'),
        txn('p1', 'brk', 'plaid', '2026-09-01'),
        txn('p2', 'brk', 'plaid', '2026-09-20'),
      ].join(', ')}`,
    );
    // The report's reply: the checking account has 60 days; the brokerage's history comes from its own transactions.
    const reply = { report: { date_generated: '2026-10-09T02:00:00Z', items: [{ accounts: [{ account_id: 'ext-chk', days_available: 60 }, { account_id: 'ext-brk', days_available: 700 }] }] } };
    await client.execute({ sql: "INSERT INTO plaid_responses (id, household_id, connection_id, run_id, endpoint, received_at, body) VALUES ('pr1', 'h1', 'c1', 'run-1', '/asset_report/get', 1, ?)", args: [JSON.stringify(reply)] });

    for (const name of files.filter((file) => file >= '0006')) await apply(client, name);

    const rows = (await client.execute('SELECT household_id, account_id, source, "from", "to" FROM transaction_ranges ORDER BY account_id, source, "from"')).rows.map((row) => ({ ...row }));
    expect(rows).toEqual([
      { household_id: 'h1', account_id: 'brk', source: 'plaid', from: '2026-09-01', to: '2026-10-08' },
      { household_id: 'h1', account_id: 'card', source: 'import', from: '2026-01-01', to: '2026-01-03' },
      { household_id: 'h1', account_id: 'card', source: 'import', from: '2026-01-05', to: '2026-01-06' },
      { household_id: 'h1', account_id: 'chk', source: 'report', from: '2026-08-09', to: '2026-10-08' },
      { household_id: 'h1', account_id: 'sav', source: 'report', from: '2026-09-15', to: '2026-10-01' },
    ]);
  });
});
