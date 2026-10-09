import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { PlaidApi } from '../server/adapters/plaid';
import * as schema from '../server/db/schema';
import { client, createHousehold, createTestDeps } from './helpers';

function fakePlaid(): PlaidApi {
  const accounts = [
    { account_id: 'brk', name: 'Brokerage', official_name: null, mask: '1234', type: 'investment', subtype: 'brokerage', balances: { current: 1500, available: null, iso_currency_code: 'USD' } },
    { account_id: 'joint', name: 'Joint IRA', official_name: null, mask: '9999', type: 'investment', subtype: 'ira', balances: { current: 500, available: null, iso_currency_code: 'USD' } },
  ];
  const securities = [
    { security_id: 's-vti', ticker_symbol: 'VTI', name: 'Vanguard Total Stock Market ETF', type: 'etf', close_price: 100, close_price_as_of: '2026-10-08', iso_currency_code: 'USD' },
    { security_id: 's-cash', ticker_symbol: 'CUR:USD', name: 'US Dollar', type: 'cash', close_price: 1, iso_currency_code: 'USD' },
  ];
  const holdings = [
    { account_id: 'brk', security_id: 's-vti', quantity: 10, institution_price: 100, institution_value: 1000, cost_basis: 800, iso_currency_code: 'USD' },
    { account_id: 'brk', security_id: 's-cash', quantity: 500, institution_price: 1, institution_value: 500, cost_basis: null, iso_currency_code: 'USD' },
    { account_id: 'joint', security_id: 's-vti', quantity: 5, institution_price: 100, institution_value: 500, cost_basis: null, iso_currency_code: 'USD' },
  ];
  return {
    env: 'sandbox',
    createLinkToken: async () => 'link-token',
    exchangePublicToken: async () => ({ accessToken: 'access-sandbox-xyz', itemId: 'item-1' }),
    getItem: async () => ({ item_id: 'item-1', institution_id: 'ins_1', consent_expiration_time: null }) as never,
    getInstitutionName: async () => 'Vanguard',
    getAccounts: async () => accounts as never,
    getHoldings: async () => ({ accounts, holdings, securities }) as never,
    getInvestmentTransactions: async () =>
      ({
        accounts,
        securities,
        investment_transactions: [
          { investment_transaction_id: 't1', account_id: 'brk', security_id: 's-vti', date: '2026-10-01', name: 'Buy VTI', type: 'buy', subtype: 'buy', quantity: 4, amount: 400, price: 100, fees: 0, iso_currency_code: 'USD' },
        ],
        total_investment_transactions: 1,
      }) as never,
    createAssetReport: async () => ({ token: 'assets-token', id: 'ar-1' }),
    getAssetReport: async () => ({ items: [] }) as never,
    removeAssetReport: async () => {},
    removeItem: async () => {},
    getWebhookVerificationKey: async () => ({}) as never,
  };
}

describe('Plaid linking and sync', () => {
  it('stores encrypted tokens, masks only, holdings and history; hiding drops data', async () => {
    const deps = await createTestDeps({ plaid: fakePlaid() });
    const home = await createHousehold(deps, 'Home', 'me@example.com');
    const api = client(deps, home.cookie);

    const linked = await api('/api/plaid/exchange', { method: 'POST', json: { publicToken: 'public-x', kind: 'investments' } });
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({ accounts: 2, holdings: 3, transactions: 1 });

    const [connection] = await deps.db.select().from(schema.connections);
    expect(connection.accessTokenEnc).not.toContain('access-sandbox');

    const accounts = (await api('/api/accounts')).body.accounts;
    expect(accounts.map((account: { mask: string }) => account.mask).sort()).toEqual(['1234', '9999']);

    const portfolio = (await api('/api/portfolio?currency=USD')).body;
    expect(portfolio.netWorth).toBe(2000_00);
    expect(portfolio.allCategories.us_stock).toBe(1500_00);
    expect(portfolio.allCategories.cash).toBe(500_00);

    // Backfill: before the 4-share buy on Oct 1 the brokerage held 6 VTI.
    const { backfillConnection } = await import('../server/services/backfill');
    const { Tenant } = await import('../server/db/tenant');
    await backfillConnection(deps, new Tenant(deps.db, home.householdId), connection.id, null);
    const brk = accounts.find((account: { name: string }) => account.name === 'Brokerage');
    const [sept] = await deps.db
      .select()
      .from(schema.holdingDaily)
      .where(eq(schema.holdingDaily.date, '2026-09-30'));
    expect(sept).toBeDefined();
    const history = (await api(`/api/history?range=1M&group=holding&accountId=${brk.id}`)).body;
    expect(history.series.length).toBeGreaterThan(0);

    // Hide the joint account (the partner links it too): it stops counting and syncing.
    const joint = accounts.find((account: { name: string }) => account.name === 'Joint IRA');
    expect((await api(`/api/accounts/${joint.id}`, { method: 'PATCH', json: { isHidden: true, purge: true } })).status).toBe(200);
    expect((await api('/api/portfolio')).body.netWorth).toBe(1500_00);

    await deps.db.update(schema.connections).set({ lastSyncedAt: null });
    await api(`/api/connections/${connection.id}/sync`, { method: 'POST' });
    const jointHoldings = await deps.db.select().from(schema.holdings).where(eq(schema.holdings.accountId, joint.id));
    expect(jointHoldings).toHaveLength(0);
    const [jointRow] = await deps.db.select().from(schema.accounts).where(eq(schema.accounts.id, joint.id));
    expect(jointRow.balance).toBeNull();
  });
});
