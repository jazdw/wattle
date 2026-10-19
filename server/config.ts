import { createFinnhub, createFrankfurter, createTiingo, createTiingoQuotes } from './adapters/marketData';
import { createPlaidClient } from './adapters/plaid';
import type { Config, Db, Deps } from './ports';
import { withBackoff } from './services/backoff';

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
  /** Live quotes: 'finnhub' (default when FINNHUB_API_KEY is set), 'tiingo' (default otherwise, with a Tiingo key), or 'none'. */
  QUOTE_PROVIDER?: string;
  /** How long a live quote is reused, in seconds (default 300). Lower it on a paid market-data plan. */
  QUOTE_CACHE_SECONDS?: string;
  /** 'none' disables FX fetching (offline tests); default Frankfurter. */
  FX_PROVIDER?: string;
  /** Cloudflare Access team domain (e.g. myteam.cloudflareaccess.com); with ACCESS_AUD enables the token check. */
  ACCESS_TEAM_DOMAIN?: string;
  /** Application Audience (AUD) tag of the Access application. */
  ACCESS_AUD?: string;
}

/**
 * Live quotes are reused this long. Tiingo's free plan allows 50 requests an
 * hour; at 5 minutes an open Holdings page costs at most 12.
 */
const DEFAULT_QUOTE_CACHE_SECONDS = 300;

function positiveInteger(value: string | undefined): number | undefined {
  const number = Number(value);
  return value && Number.isInteger(number) && number > 0 ? number : undefined;
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
    quoteCacheSeconds: positiveInteger(env.QUOTE_CACHE_SECONDS) ?? DEFAULT_QUOTE_CACHE_SECONDS,
    googleClientId: env.GOOGLE_CLIENT_ID || undefined,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || undefined,
    tokenEncKey: env.TOKEN_ENC_KEY || undefined,
    access:
      env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD ? { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD } : undefined,
  };
}

/**
 * Which provider gives live quotes: Finnhub when its key is set (60 calls a
 * minute free, so quotes needn't eat into Tiingo's 50 an hour), else Tiingo.
 * QUOTE_PROVIDER overrides ('finnhub', 'tiingo' or 'none').
 */
function quoteProviderName(env: RawEnv): 'finnhub' | 'tiingo' | null {
  const choice = env.QUOTE_PROVIDER ?? (env.FINNHUB_API_KEY ? 'finnhub' : 'tiingo');
  if (choice === 'finnhub' && env.FINNHUB_API_KEY) return 'finnhub';
  if (choice === 'tiingo' && env.TIINGO_API_KEY) return 'tiingo';
  return null;
}

function quoteProvider(env: RawEnv) {
  const name = quoteProviderName(env);
  if (name === 'finnhub') return createFinnhub(env.FINNHUB_API_KEY!);
  if (name === 'tiingo') return createTiingoQuotes(env.TIINGO_API_KEY!);
  return null;
}

/** Build the dependency set from environment variables and a database. */
export function depsFromEnv(env: RawEnv, db: Db, background: Deps['background']): Deps {
  const deps: Deps = {
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
    quotes: quoteProvider(env),
    fx: env.FX_PROVIDER === 'none' ? null : createFrankfurter(),
    now: () => new Date(),
    background,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  // Back off from a provider that says "too many requests". Tiingo's prices
  // and quotes share one key, so they share one limit.
  if (deps.prices) deps.prices = withBackoff(deps.prices, 'tiingo', () => deps);
  if (deps.quotes) deps.quotes = withBackoff(deps.quotes, quoteProviderName(env)!, () => deps);
  if (deps.fx) deps.fx = withBackoff(deps.fx, 'frankfurter', () => deps);
  return deps;
}
