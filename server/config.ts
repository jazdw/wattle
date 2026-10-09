import { createFinnhub, createFrankfurter, createTiingo } from './adapters/marketData';
import { createPlaidClient } from './adapters/plaid';
import type { Config, Db, Deps } from './ports';

/** Environment variables / secrets, identical on Workers (.dev.vars) and Node (process.env). */
export interface RawEnv {
  ALLOWED_EMAILS?: string;
  DEV_LOGIN_EMAILS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  TOKEN_ENC_KEY?: string;
  ADMIN_TOKEN?: string;
  PLAID_CLIENT_ID?: string;
  PLAID_SECRET?: string;
  PLAID_ENV?: string;
  TIINGO_API_KEY?: string;
  FINNHUB_API_KEY?: string;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function configFromEnv(env: RawEnv): Config {
  return {
    allowedEmails: list(env.ALLOWED_EMAILS),
    devLoginEmails: list(env.DEV_LOGIN_EMAILS),
    googleClientId: env.GOOGLE_CLIENT_ID || undefined,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || undefined,
    tokenEncKey: env.TOKEN_ENC_KEY || undefined,
    adminToken: env.ADMIN_TOKEN || undefined,
  };
}

/** Build the dependency set from environment variables and a database. */
export function depsFromEnv(env: RawEnv, db: Db, background: Deps['background']): Deps {
  return {
    db,
    config: configFromEnv(env),
    plaid:
      env.PLAID_CLIENT_ID && env.PLAID_SECRET
        ? createPlaidClient({
            clientId: env.PLAID_CLIENT_ID,
            secret: env.PLAID_SECRET,
            env: env.PLAID_ENV === 'production' ? 'production' : 'sandbox',
          })
        : null,
    prices: env.TIINGO_API_KEY ? createTiingo(env.TIINGO_API_KEY) : null,
    quotes: env.FINNHUB_API_KEY ? createFinnhub(env.FINNHUB_API_KEY) : null,
    fx: createFrankfurter(),
    now: () => new Date(),
    background,
  };
}
