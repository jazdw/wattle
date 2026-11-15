/**
 * Plaid's bank transactions beside a bank report's and a file's: import >
 * Plaid's > a report's (server/services/importedRecord.ts). Made-up values
 * throughout.
 */
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../server/db/schema';
import { Tenant } from '../server/db/tenant';
import { syncConnection } from '../server/services/sync';
import type { ImportedFile } from '../shared/schemas';
import { account, bankTxn, fakePlaid, type PlaidState } from './fakes';
import { client, createHousehold, createTestDeps, settle } from './helpers';

type Listed = { id: string; source: string; date: string; amount: number; description: string | null; fileDescription: string | null; plaidCategoryDetailed: string | null; merchant: string | null; kind: string; kindByYou: boolean; transfer: { id: string } | null };

/** A bank login (checking and savings) with a bank report; Plaid's bank transactions not ready at the link. */
async function setup(reportTransactions: PlaidState['reportTransactions'] = {}) {
  const plaid = fakePlaid({
    itemId: 'item-bank',
    institutionName: 'Example Bank',
    accounts: [account('chk', 'depository', 1000, { mask: '1234' }), account('sav', 'depository', 5000, { mask: '9012' })],
    historicalBalances: { chk: [{ date: '2026-07-01', current: 1000 }], sav: [{ date: '2026-07-01', current: 5000 }] },
    reportTransactions,
    bankPages: [{ next_cursor: '', transactions_update_status: 'NOT_READY' }],
  });
  const deps = await createTestDeps({ plaid });
  const home = await createHousehold(deps, 'Home', 'me@example.com');
  const api = client(deps, home.cookie);
  await api('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'p', kind: 'account' } });
  await settle(deps);
  const tenant = new Tenant(deps.db, home.householdId);
  const accountId = async (externalId: string) => (await deps.db.select().from(schema.accounts).where(eq(schema.accounts.externalId, externalId)))[0].id;
  const row = async (source: 'bank' | 'report' | 'import', externalId: string) =>
    (await deps.db.select().from(schema.transactions).where(and(eq(schema.transactions.source, source), eq(schema.transactions.externalId, externalId))))[0];
  const sync = async () => {
    const [connection] = await deps.db.select().from(schema.connections);
    await syncConnection(deps, tenant, connection.id, 'manual');
    await settle(deps);
  };
  const listed = async (externalId: string) => ((await api(`/api/accounts/${await accountId(externalId)}/transactions`)).body.transactions as Listed[]).slice().reverse();
  return { deps, plaid, api, accountId, row, sync, listed };
}

const report = (id: string, date: string, amount: number, description: string) => ({ transaction_id: id, date, amount, original_description: description, pending: false });

describe("Plaid's bank transactions over a report's", () => {
  it("replace the report's on the days they cover, taking a kind you set and a transfer you confirmed", async () => {
    const { deps, plaid, api, row, sync, listed } = await setup({
      chk: [report('r0', '2026-08-01', 25, 'OLDER PAYMENT'), report('r1', '2026-09-20', 500, 'TRANSFER TO SAVINGS'), report('r2', '2026-09-25', 12, 'SERVICE CHARGE')],
      sav: [report('r3', '2026-09-20', -500, 'TRANSFER FROM CHECKING')],
    });
    expect((await listed('chk')).map((entry) => [entry.source, entry.date])).toEqual([
      ['report', '2026-08-01'],
      ['report', '2026-09-20'],
      ['report', '2026-09-25'],
    ]);
    // A kind you set, and the transfer (matched automatically after the report) confirmed.
    const r1 = await row('report', 'r1');
    await api(`/api/transactions/${r1.id}`, { method: 'PATCH', json: { kind: 'withdrawal' } });
    const [linked] = await deps.db.select().from(schema.transfers);
    expect(linked).toMatchObject({ outId: r1.id, inId: (await row('report', 'r3')).id, status: 'auto' });
    expect((await api(`/api/transfers/${linked.id}`, { method: 'PATCH', json: { status: 'confirmed' } })).status).toBe(200);

    // Plaid's: the transfer a day later under its own ids, the charge under the report's id.
    plaid.state.bankPages.push({
      added: [
        bankTxn('b1', 'chk', '2026-09-21', 500, { original_description: 'ONLINE TRANSFER TO SAVINGS 1234567890' }),
        bankTxn('r2', 'chk', '2026-09-25', 12, { original_description: 'MONTHLY SERVICE CHARGE', personal_finance_category: { primary: 'BANK_FEES', detailed: 'BANK_FEES_OTHER_BANK_FEES' } }),
        bankTxn('b3', 'sav', '2026-09-21', -500, { original_description: 'ONLINE TRANSFER FROM CHECKING 1234567890' }),
      ],
      next_cursor: 'c1',
    });
    await sync();
    const [b1, b2, b3] = [await row('bank', 'b1'), await row('bank', 'r2'), await row('bank', 'b3')];
    expect((await row('report', 'r1')).replacedBy).toBe(b1.id);
    expect((await row('report', 'r2')).replacedBy).toBe(b2.id);
    expect((await row('report', 'r3')).replacedBy).toBe(b3.id);
    expect(b1.kind).toBe('withdrawal');
    // Only the bank transactions count on their days; the older report one still does.
    const entries = await listed('chk');
    expect(entries.map((entry) => [entry.source, entry.date, entry.description])).toEqual([
      ['report', '2026-08-01', 'OLDER PAYMENT'],
      ['bank', '2026-09-21', 'ONLINE TRANSFER TO SAVINGS 1234567890'],
      ['bank', '2026-09-25', 'MONTHLY SERVICE CHARGE'],
    ]);
    expect(entries[1]).toMatchObject({ kind: 'withdrawal', kindByYou: true, transfer: { id: linked.id } });
    // Plaid's category says it's a fee.
    expect(entries[2]).toMatchObject({ kind: 'fee', kindByYou: false });
    const [moved] = await deps.db.select().from(schema.transfers);
    expect(moved).toMatchObject({ id: linked.id, outId: b1.id, inId: b3.id, status: 'confirmed' });
    // Nothing is deleted.
    expect(await deps.db.select().from(schema.transactions).where(eq(schema.transactions.source, 'report'))).toHaveLength(4);
  });
});

describe("a file's transactions over Plaid's bank transactions", () => {
  it("show Plaid's description, category and merchant, keep the file's own text, and a re-import changes neither", async () => {
    const { deps, plaid, api, accountId, row, sync, listed } = await setup();
    const chk = await accountId('chk');
    const file: ImportedFile = {
      kind: 'balances',
      rows: [
        { date: '2026-09-10', balance: 1100 },
        { date: '2026-09-20', balance: 1000 },
      ],
      transactions: [{ id: 'T1', date: '2026-09-14', kind: 'withdrawal', label: 'DEBIT', description: 'EXAMPLE GROCER', amount: -100_00 }],
    };
    const importing = () => api('/api/imports', { method: 'POST', json: { accounts: [{ label: '··1234', target: { accountId: chk }, file }] } });
    expect((await importing()).status).toBe(200);
    await settle(deps);

    // Plaid's arrive after the file: the same purchase a day later, with Plaid's details.
    plaid.state.bankPages.push({
      added: [
        bankTxn('b1', 'chk', '2026-09-15', 100, {
          original_description: 'EXAMPLE GROCER #123 ANYTOWN',
          merchant_name: 'Example Grocer',
          personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES', confidence_level: 'HIGH' },
        }),
      ],
      next_cursor: 'c1',
    });
    await sync();
    const check = async () => {
      const [imported, bank] = [await row('import', 'T1'), await row('bank', 'b1')];
      expect(imported.description).toBe('EXAMPLE GROCER');
      expect(bank).toMatchObject({ replacedBy: imported.id, description: 'EXAMPLE GROCER #123 ANYTOWN', plaidCategoryDetailed: 'FOOD_AND_DRINK_GROCERIES', merchantName: 'Example Grocer' });
      const entries = await listed('chk');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        id: imported.id,
        source: 'import',
        date: '2026-09-14',
        amount: 100_00,
        description: 'EXAMPLE GROCER #123 ANYTOWN',
        fileDescription: 'EXAMPLE GROCER',
        plaidCategoryDetailed: 'FOOD_AND_DRINK_GROCERIES',
        merchant: 'Example Grocer',
        kind: 'withdrawal',
      });
    };
    await check();
    // Found by either text.
    expect(((await api(`/api/accounts/${chk}/transactions?q=ANYTOWN`)).body.transactions as unknown[]).length).toBe(1);

    expect((await importing()).status).toBe(200);
    await settle(deps);
    await check();
  });

  it('moves a transfer you confirmed to the files when both its sides are imported', async () => {
    const { deps, plaid, api, accountId, row, sync } = await setup();
    plaid.state.bankPages.push({ added: [bankTxn('b1', 'chk', '2026-09-15', 250), bankTxn('b3', 'sav', '2026-09-15', -250)], next_cursor: 'c1' });
    await sync();
    const [b1, b3] = [await row('bank', 'b1'), await row('bank', 'b3')];
    const [linked] = await deps.db.select().from(schema.transfers);
    expect(linked).toMatchObject({ outId: b1.id, inId: b3.id, status: 'auto' });
    expect((await api(`/api/transfers/${linked.id}`, { method: 'PATCH', json: { status: 'confirmed' } })).status).toBe(200);

    const statement = (id: string, amount: number): ImportedFile => ({
      kind: 'balances',
      rows: [
        { date: '2026-09-10', balance: 1000 },
        { date: '2026-09-20', balance: 1000 },
      ],
      transactions: [{ id, date: '2026-09-14', kind: amount < 0 ? 'withdrawal' : 'deposit', label: 'XFER', description: 'TRANSFER', amount }],
    });
    // Both files in one import: both sides pair in one matching run.
    const response = await api('/api/imports', {
      method: 'POST',
      json: {
        accounts: [
          { label: '··1234', target: { accountId: await accountId('chk') }, file: statement('T1', -250_00) },
          { label: '··9012', target: { accountId: await accountId('sav') }, file: statement('T3', 250_00) },
        ],
      },
    });
    expect(response.status).toBe(200);
    await settle(deps);
    const transfers = await deps.db.select().from(schema.transfers);
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({ id: linked.id, outId: (await row('import', 'T1')).id, inId: (await row('import', 'T3')).id, status: 'confirmed' });
  });
});
