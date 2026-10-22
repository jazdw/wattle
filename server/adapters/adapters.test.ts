import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFinnhub, createFrankfurter, createTiingo, createTiingoQuotes } from './marketData';
import { createPlaidClient, PlaidApiError } from './plaid';

/** Record requests and answer from a handler. */
function stubFetch(handler: (url: string, body: unknown) => Response) {
  const requests: { url: string; body: unknown; headers: Headers }[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, body, headers: new Headers(init?.headers) });
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
    expect(requests[0]).toMatchObject({
      url: 'https://sandbox.plaid.com/accounts/get',
      body: { client_id: 'cid', secret: 'sec', access_token: 'access-1' },
    });
    expect(createPlaidClient({ clientId: 'c', secret: 's', env: 'production' }).env).toBe('production');
  });

  it('requests products per link kind and never the auth product', async () => {
    const requests = stubFetch(() => Response.json({ link_token: 'lt' }));
    await plaid.createLinkToken({ clientUserId: 'u1', kind: 'investments', webhook: 'https://x/api/plaid/webhook' });
    await plaid.createLinkToken({ clientUserId: 'u1', kind: 'account', webhook: null });
    await plaid.createLinkToken({ clientUserId: 'u1', kind: 'account', webhook: null, accessToken: 'access-1' });
    const [investments, account, update] = requests.map((request) => request.body as Record<string, unknown>);
    expect(investments).toMatchObject({
      products: ['investments'],
      additional_consented_products: ['transactions'],
      webhook: 'https://x/api/plaid/webhook',
      user: { client_user_id: 'u1' },
    });
    expect(investments.required_if_supported_products).toBeUndefined();
    // Any login: balance history first, holdings where there are investment accounts.
    expect(account).toMatchObject({
      products: ['assets'],
      required_if_supported_products: ['investments'],
      additional_consented_products: ['transactions'],
    });
    expect(account.webhook).toBeUndefined();
    expect(update).toMatchObject({ access_token: 'access-1' });
    expect(update.products).toBeUndefined();
    expect(update.update).toBeUndefined();
    await plaid.createLinkToken({ clientUserId: 'u1', kind: 'account', webhook: null, accessToken: 'access-1', chooseAccounts: true });
    expect(requests[3].body).toMatchObject({ access_token: 'access-1', update: { account_selection_enabled: true } });
    for (const body of [investments, account, update]) expect(JSON.stringify(body)).not.toContain('"auth"');
  });

  it('never passes on account or routing numbers, or account owners, wherever Plaid puts them', async () => {
    stubFetch(() =>
      Response.json({
        accounts: [{ account_id: 'a1', mask: '1234', name: 'Checking', numbers: { ach: [{ account: '1111222233334444', routing: '011000015' }] } }],
        report: {
          items: [{ accounts: [{ account_id: 'a1', mask: '1234', account_number: '1111222233334444', owners: [{ names: ['Pat'], addresses: [{}] }], historical_balances: [{ date: '2026-10-01', current: 5 }] }] }],
        },
        liabilities: { student: [{ account_id: 's1', account_number: '4277000000', routing_number: '011000015', wire_routing: '026009593' }] },
      }),
    );
    const accounts = await plaid.getAccounts('a');
    const report = await plaid.getAssetReport('t');
    const seen = JSON.stringify({ accounts, report });
    for (const secret of ['1111222233334444', '011000015', '4277000000', '026009593', 'Pat']) expect(seen).not.toContain(secret);
    expect(accounts[0]).toMatchObject({ account_id: 'a1', mask: '1234', name: 'Checking' });
    expect(seen).toContain('"historical_balances"');
  });

  it('only calls the endpoints it allows: none that return account numbers', async () => {
    const { PLAID_ENDPOINTS } = await import('./plaid');
    for (const endpoint of ['/auth/get', '/liabilities/get', '/identity/get', '/processor/token/create', '/transactions/sync']) {
      expect(PLAID_ENDPOINTS.has(endpoint)).toBe(false);
    }
    const requests = stubFetch(() => Response.json({}));
    // Every wrapped method only reaches allowed endpoints.
    await Promise.allSettled([
      plaid.getItem('a'),
      plaid.getAccounts('a'),
      plaid.getHoldings('a'),
      plaid.getInvestmentTransactions('a', '2026-01-01', '2026-02-01', 0),
      plaid.getAssetReport('t'),
      plaid.removeAssetReport('t'),
      plaid.removeItem('a'),
      plaid.exchangePublicToken('p'),
      plaid.getInstitutionName('ins'),
      plaid.getWebhookVerificationKey('k'),
      plaid.createAssetReport('a', 30, null),
      plaid.createLinkToken({ clientUserId: 'u', kind: 'account', webhook: null }),
    ]);
    for (const request of requests) expect(PLAID_ENDPOINTS.has(new URL(request.url).pathname)).toBe(true);
    expect(requests.length).toBeGreaterThanOrEqual(12);
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
    expect(requests[0].url).toBe('https://api.tiingo.com/tiingo/daily/vtsax/prices?startDate=2026-10-01&endDate=2026-10-02');
    expect(requests[0].headers.get('authorization')).toBe('Token key'); // never in the URL
    expect(await tiingo.dailyCloses('NOPE', '2026-10-01', '2026-10-02')).toEqual([]);
    await expect(tiingo.dailyCloses('BOOM', '2026-10-01', '2026-10-02')).rejects.toThrow('HTTP 500');
  });

  it('Tiingo: latest closes for many tickers in one request', async () => {
    const requests = stubFetch(() =>
      Response.json([
        { ticker: 'VTI', timestamp: '2026-10-08T20:00:00+00:00', tngoLast: 301.5 }, // 16:00 New York: the close
        { ticker: 'SPY', timestamp: '2026-10-08T15:00:00+00:00', tngoLast: 600 }, // 11:00: intraday, not a close
        { ticker: 'QQQ', timestamp: '2026-10-08T20:00:00+00:00', tngoLast: 500 }, // not requested
        { ticker: 'IWM', timestamp: '2026-10-08T20:30:00+00:00', tngoLast: null },
      ]),
    );
    const closes = await createTiingo('key').latestCloses!(['vti', 'SPY', 'IWM']);
    expect([...closes]).toEqual([['VTI', { date: '2026-10-08', close: 301.5 }]]);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://api.tiingo.com/iex/?tickers=vti%2Cspy%2Ciwm');
    expect(requests[0].headers.get('authorization')).toBe('Token key');
  });

  it('Tiingo: splits large bulk requests and reports errors', async () => {
    const requests = stubFetch(() => Response.json([]));
    await createTiingo('key').latestCloses!(Array.from({ length: 150 }, (_, index) => `T${index}`));
    expect(requests).toHaveLength(2);
    stubFetch(() => new Response('', { status: 403 }));
    await expect(createTiingo('key').latestCloses!(['VTI'])).rejects.toThrow('HTTP 403');
  });

  it('Tiingo: describes a ticker from its search, preferring the US listing', async () => {
    const requests = stubFetch((url) =>
      Response.json(
        url.includes('query=VTI')
          ? [
              { ticker: 'VTI', name: 'Vanguard Total Stock Market ETF', assetType: 'ETF', countryCode: 'US' },
              { ticker: 'VTI', name: 'Visionstate Corp', assetType: 'Stock', countryCode: 'CA' },
              { ticker: 'VTIP', name: 'Vanguard Short-Term Inflation-Protected', assetType: 'ETF', countryCode: 'US' },
            ]
          : url.includes('query=VTSAX')
            ? [{ ticker: 'VTSAX', name: 'Vanguard Total Stock Market Index Admiral', assetType: 'Mutual Fund', countryCode: 'US' }]
            : [{ ticker: 'NOPEX', name: 'Something else', assetType: 'Stock', countryCode: 'US' }],
      ),
    );
    const tiingo = createTiingo('key');
    expect(await tiingo.describe!('VTI')).toEqual({ type: 'etf', name: 'Vanguard Total Stock Market ETF' });
    expect(await tiingo.describe!('vtsax')).toEqual({ type: 'mutual fund', name: 'Vanguard Total Stock Market Index Admiral' });
    expect(await tiingo.describe!('ZZZZ')).toBeNull(); // no exact match
    expect(requests[0].url).toBe('https://api.tiingo.com/tiingo/utilities/search?query=VTI&limit=10');
    expect(requests[0].headers.get('authorization')).toBe('Token key');
  });

  it('Tiingo: live quotes for many tickers in one request', async () => {
    const requests = stubFetch(() =>
      Response.json([
        { ticker: 'VTI', timestamp: '2026-10-19T10:39:50-04:00', tngoLast: 375.86, prevClose: 374.07 },
        { ticker: 'SPY', timestamp: '2026-10-19T10:39:49-04:00', tngoLast: 767.26, prevClose: null },
        { ticker: 'AAPL', timestamp: '2026-10-19T10:39:49-04:00', tngoLast: 1, prevClose: 1 }, // not asked for
      ]),
    );
    const quotes = await createTiingoQuotes('key').quotes!(['vti', 'SPY']);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://api.tiingo.com/iex/?tickers=vti%2Cspy');
    expect(requests[0].headers.get('authorization')).toBe('Token key');
    expect(quotes).toEqual([
      { ticker: 'VTI', price: 375.86, change: expect.closeTo(1.79, 5), changePercent: expect.closeTo(1.79 / 374.07, 6), previousClose: 374.07, time: Date.parse('2026-10-19T14:39:50Z') },
      // No previous close: no change rather than a made-up one.
      { ticker: 'SPY', price: 767.26, change: 0, changePercent: 0, previousClose: 767.26, time: Date.parse('2026-10-19T14:39:49Z') },
    ]);
    stubFetch(() => Response.json([]));
    expect(await createTiingoQuotes('key').quote('ZZZ')).toBeNull();
  });

  it('Finnhub: quotes, unknown symbols, errors', async () => {
    const requests = stubFetch((url) =>
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
    expect(requests[0].url).toBe('https://finnhub.io/api/v1/quote?symbol=VTI');
    expect(requests[0].headers.get('x-finnhub-token')).toBe('key');
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
