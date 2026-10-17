import { createFinnhub, createFrankfurter, createTiingo } from './adapters/marketData';
import { createPlaidClient } from './adapters/plaid';
import type { Config, Db, Deps } from './ports';

/** Environment variables / secrets, identical on Workers (.dev.vars) and Node (process.env). */
export interface RawEnv {
  DEV_LOGIN_EMAILS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  TOKEN_ENC_KEY?: string;
  PLAID_CLIENT_ID?: string;
  PLAID_SECRET?: string;
  PLAID_ENV?: string;
  TIINGO_API_KEY?: string;
  FINNHUB_API_KEY?: string;
  /** 'none' disables FX fetching (offline tests); default Frankfurter. */
  FX_PROVIDER?: string;
  /** Cloudflare Access team domain (e.g. myteam.cloudflareaccess.com); with ACCESS_AUD enables the token check. */
  ACCESS_TEAM_DOMAIN?: string;
  /** Application Audience (AUD) tag of the Access application. */
  ACCESS_AUD?: string;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function configFromEnv(env: RawEnv): Config {
  return {
    devLoginEmails: list(env.DEV_LOGIN_EMAILS),
    googleClientId: env.GOOGLE_CLIENT_ID || undefined,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || undefined,
    tokenEncKey: env.TOKEN_ENC_KEY || undefined,
    access:
      env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD ? { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD } : undefined,
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
    fx: env.FX_PROVIDER === 'none' ? null : createFrankfurter(),
    now: () => new Date(),
    background,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
