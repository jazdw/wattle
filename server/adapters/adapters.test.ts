import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFinnhub, createFrankfurter, createTiingo } from './marketData';
import { createPlaidClient, PlaidApiError } from './plaid';

/** Record requests and answer from a handler. */
function stubFetch(handler: (url: string, body: unknown) => Response) {
  const requests: { url: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, body });
    return handler(url, body);
  });
  return requests;
}

afterEach(() => vi.unstubAllGlobals());

describe('Plaid client', () => {
  const plaid = createPlaidClient({ clientId: 'cid', secret: 'sec', env: 'sandbox' });

  it('authenticates every call and targets the configured environment', async () => {
    const requests = stubFetch(() => Response.json({ accounts: [] }));
    await plaid.getAccounts('access-1');
    expect(requests[0]).toEqual({
      url: 'https://sandbox.plaid.com/accounts/get',
      body: { client_id: 'cid', secret: 'sec', access_token: 'access-1' },
    });
    expect(createPlaidClient({ clientId: 'c', secret: 's', env: 'production' }).env).toBe('production');
  });

  it('requests products per link kind and never the auth product', async () => {
    const requests = stubFetch(() => Response.json({ link_token: 'lt' }));
    await plaid.createLinkToken({ clientUserId: 'u1', kind: 'investments', webhook: 'https://x/api/plaid/webhook' });
    await plaid.createLinkToken({ clientUserId: 'u1', kind: 'banking', webhook: null });
    await plaid.createLinkToken({ clientUserId: 'u1', kind: 'banking', webhook: null, accessToken: 'access-1' });
    const [investments, banking, update] = requests.map((request) => request.body as Record<string, unknown>);
    expect(investments).toMatchObject({ products: ['investments'], webhook: 'https://x/api/plaid/webhook', user: { client_user_id: 'u1' } });
    expect(banking).toMatchObject({ products: ['assets'] });
    expect(banking.webhook).toBeUndefined();
    expect(update).toMatchObject({ access_token: 'access-1' });
    expect(update.products).toBeUndefined();
    for (const body of [investments, banking, update]) expect(JSON.stringify(body)).not.toContain('"auth"');
  });

  it('maps API errors to PlaidApiError', async () => {
    stubFetch(() => Response.json({ error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'login' }, { status: 400 }));
    const error = await plaid.getHoldings('a').catch((caught) => caught);
    expect(error).toBeInstanceOf(PlaidApiError);
    expect(error).toMatchObject({ code: 'ITEM_LOGIN_REQUIRED', type: 'ITEM_ERROR', status: 400 });

    stubFetch(() => new Response('bad gateway', { status: 502, statusText: 'Bad Gateway' }));
    expect(await plaid.getItem('a').catch((caught) => caught.code)).toBe('UNKNOWN');
  });

  it('wraps the remaining endpoints', async () => {
    const requests = stubFetch((url) => {
      if (url.endsWith('/item/public_token/exchange')) return Response.json({ access_token: 'acc', item_id: 'item' });
      if (url.endsWith('/item/get')) return Response.json({ item: { item_id: 'item' } });
      if (url.endsWith('/institutions/get_by_id')) return Response.json({ institution: { name: 'Vanguard' } });
      if (url.endsWith('/asset_report/create')) return Response.json({ asset_report_token: 'art', asset_report_id: 'ari' });
      if (url.endsWith('/asset_report/get')) return Response.json({ report: { items: [] } });
      if (url.endsWith('/webhook_verification_key/get')) return Response.json({ key: { kid: 'k' } });
      if (url.endsWith('/investments/transactions/get')) return Response.json({ investment_transactions: [], total_investment_transactions: 0 });
      return Response.json({});
    });
    expect(await plaid.exchangePublicToken('pub')).toEqual({ accessToken: 'acc', itemId: 'item' });
    expect((await plaid.getItem('acc')).item_id).toBe('item');
    expect(await plaid.getInstitutionName('ins_1')).toBe('Vanguard');
    expect(await plaid.createAssetReport('acc', 731, 'https://x/hook')).toEqual({ token: 'art', id: 'ari' });
    expect(await plaid.getAssetReport('art')).toEqual({ items: [] });
    await plaid.removeAssetReport('art');
    await plaid.removeItem('acc');
    expect(await plaid.getWebhookVerificationKey('k')).toEqual({ kid: 'k' });
    await plaid.getInvestmentTransactions('acc', '2026-01-01', '2026-02-01', 500);
    const txn = requests.find((request) => request.url.endsWith('/investments/transactions/get'))!.body;
    expect(txn).toMatchObject({ start_date: '2026-01-01', end_date: '2026-02-01', options: { count: 500, offset: 500 } });
    const asset = requests.find((request) => request.url.endsWith('/asset_report/create'))!.body;
    expect(asset).toMatchObject({ access_tokens: ['acc'], days_requested: 731, options: { webhook: 'https://x/hook' } });
  });

  it('returns null when an institution lookup fails', async () => {
    stubFetch(() => Response.json({ error_code: 'INVALID_INSTITUTION' }, { status: 400 }));
    expect(await plaid.getInstitutionName('nope')).toBeNull();
  });
});

describe('market data', () => {
  it('Tiingo: daily closes, unknown tickers, errors', async () => {
    const requests = stubFetch((url) =>
      url.includes('/nope/') ? new Response('', { status: 404 }) : url.includes('/boom/') ? new Response('', { status: 500 }) : Response.json([{ date: '2026-10-01T00:00:00.000Z', close: 101.5 }, { date: '2026-10-02T00:00:00.000Z', close: null }]),
    );
    const tiingo = createTiingo('key');
    expect(await tiingo.dailyCloses('VTSAX', '2026-10-01', '2026-10-02')).toEqual([{ date: '2026-10-01', close: 101.5 }]);
    expect(requests[0].url).toContain('/tiingo/daily/vtsax/prices?startDate=2026-10-01&endDate=2026-10-02&token=key');
    expect(await tiingo.dailyCloses('NOPE', '2026-10-01', '2026-10-02')).toEqual([]);
    await expect(tiingo.dailyCloses('BOOM', '2026-10-01', '2026-10-02')).rejects.toThrow('HTTP 500');
  });

  it('Finnhub: quotes, unknown symbols, errors', async () => {
    stubFetch((url) =>
      url.includes('symbol=ZZZ')
        ? Response.json({ c: 0, d: null, dp: null, pc: 0, t: 0 })
        : url.includes('symbol=ERR')
          ? new Response('', { status: 429 })
          : Response.json({ c: 310, d: 2, dp: 0.65, pc: 308, t: 1_700_000_000 }),
    );
    const finnhub = createFinnhub('key');
    expect(await finnhub.quote('vti')).toEqual({
      ticker: 'VTI',
      price: 310,
      change: 2,
      changePercent: expect.closeTo(0.0065, 10),
      previousClose: 308,
      time: 1_700_000_000_000,
    });
    expect(await finnhub.quote('ZZZ')).toBeNull();
    await expect(finnhub.quote('ERR')).rejects.toThrow('HTTP 429');
  });

  it('Frankfurter: single days and ranges', async () => {
    const requests = stubFetch((url) =>
      url.includes('..')
        ? Response.json({ rates: { '2026-10-01': { AUD: 1.43 }, '2026-10-02': { AUD: 1.44 } } })
        : Response.json({ date: '2026-10-02', rates: { AUD: 1.44 } }),
    );
    const fx = createFrankfurter();
    expect(await fx.rates('USD', 'AUD', '2026-10-01', '2026-10-02')).toEqual([
      { date: '2026-10-01', rate: 1.43 },
      { date: '2026-10-02', rate: 1.44 },
    ]);
    expect(await fx.rates('USD', 'AUD', '2026-10-04', '2026-10-04')).toEqual([{ date: '2026-10-02', rate: 1.44 }]);
    expect(requests[0].url).toBe('https://api.frankfurter.dev/v1/2026-10-01..2026-10-02?base=USD&symbols=AUD');
  });
});
