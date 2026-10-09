import { describe, expect, it } from 'vitest';
import { configFromEnv, depsFromEnv } from './config';
import type { Db } from './ports';

describe('config', () => {
  it('parses lists and leaves unset secrets undefined', () => {
    const config = configFromEnv({ ALLOWED_EMAILS: ' A@x.com, b@x.com ,', GOOGLE_CLIENT_ID: '' });
    expect(config.allowedEmails).toEqual(['a@x.com', 'b@x.com']);
    expect(config.devLoginEmails).toEqual([]);
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
});
