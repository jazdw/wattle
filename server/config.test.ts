import { describe, expect, it } from 'vitest';
import { configFromEnv, depsFromEnv } from './config';
import type { Db } from './ports';

describe('config', () => {
  it('parses lists and leaves unset secrets undefined', () => {
    const config = configFromEnv({ DEV_LOGIN_EMAILS: ' A@x.com, b@x.com ,', GOOGLE_CLIENT_ID: '' });
    expect(config.devLoginEmails).toEqual(['a@x.com', 'b@x.com']);
    expect(config.googleClientId).toBeUndefined();
  });

  it('only enables providers that have credentials', () => {
    const none = depsFromEnv({}, {} as Db, () => {});
    expect([none.plaid, none.prices, none.quotes]).toEqual([null, null, null]);
    expect(none.fx).not.toBeNull();

    const all = depsFromEnv(
      { PLAID_CLIENT_ID: 'c', PLAID_SECRET: 's', PLAID_ENV: 'production', TIINGO_API_KEY: 't', FINNHUB_API_KEY: 'f' },
      {} as Db,
      () => {},
    );
    expect(all.plaid?.env).toBe('production');
    expect(all.prices).not.toBeNull();
    expect(all.quotes).not.toBeNull();
    expect(depsFromEnv({ PLAID_CLIENT_ID: 'c', PLAID_SECRET: 's', PLAID_ENV: 'nonsense' }, {} as Db, () => {}).plaid?.env).toBe('sandbox');
  });

  it('reuses live quotes for 5 minutes unless QUOTE_CACHE_SECONDS says otherwise', () => {
    expect(configFromEnv({}).quoteCacheSeconds).toBe(300);
    expect(configFromEnv({ QUOTE_CACHE_SECONDS: '60' }).quoteCacheSeconds).toBe(60);
    expect(configFromEnv({ QUOTE_CACHE_SECONDS: 'soon' }).quoteCacheSeconds).toBe(300);
    expect(configFromEnv({ QUOTE_CACHE_SECONDS: '0' }).quoteCacheSeconds).toBe(300);
  });

  it('takes live quotes from Tiingo unless QUOTE_PROVIDER picks Finnhub or none', () => {
    const quotes = (env: Record<string, string>) => depsFromEnv(env, {} as Db, () => {}).quotes;
    expect(quotes({ TIINGO_API_KEY: 't', FINNHUB_API_KEY: 'f' })?.quotes).toBeTypeOf('function'); // Tiingo: bulk
    expect(quotes({ TIINGO_API_KEY: 't', FINNHUB_API_KEY: 'f', QUOTE_PROVIDER: 'finnhub' })?.quotes).toBeUndefined(); // Finnhub
    expect(quotes({ TIINGO_API_KEY: 't', QUOTE_PROVIDER: 'none' })).toBeNull();
    expect(quotes({ FINNHUB_API_KEY: 'f' })).toBeNull(); // Finnhub only when chosen
  });
});
