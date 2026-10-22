/**
 * Platform-neutral dependencies of the app. The Cloudflare entry
 * (worker/index.ts) and the Node entry (node/server.ts) each build a `Deps`
 * and pass it to the Hono app as `c.env.deps`; nothing under server/ imports
 * Cloudflare APIs.
 */
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import type { Currency } from '../shared/money';
import type { IsoDate } from '../shared/dates';
import type * as schema from './db/schema';
import type { PlaidApi } from './adapters/plaid';

/** Drizzle database over D1 (Workers) or libsql (Node/tests). Both are async. */
export type Db = BaseSQLiteDatabase<'async', any, typeof schema>;

export interface Config {
  /** LOCAL DEVELOPMENT ONLY: emails that can sign in without Google on a private host. */
  devLoginEmails: string[];
  /** How long a live quote is reused, in seconds (QUOTE_CACHE_SECONDS; default 300). */
  quoteCacheSeconds: number;
  googleClientId?: string;
  googleClientSecret?: string;
  /** base64-encoded 32-byte key(s) for encrypting aggregator tokens: "v1:<key>[,v0:<key>]" or just "<key>". */
  tokenEncKey?: string;
  /**
   * PLAID_ALLOW_REMOVE: Disconnect also removes the login at Plaid (/item/remove),
   * which can't be undone. Off by default: a disconnected login is kept so it
   * can be reconnected without using another Item (Plaid's Trial plan counts removed ones).
   */
  plaidAllowRemove: boolean;
  /**
   * JOB_CHUNK_ROWS: about how many rows one background job builds and writes
   * (default 1,000). Sized for Workers Free's 10 ms of CPU per invocation;
   * raise it on Workers Paid for fewer, larger jobs.
   */
  jobChunkRows: number;
  /** When set, /api requests must carry a valid Cloudflare Access token for this team and application. */
  access?: { teamDomain: string; audience: string };
}

export interface DailyClose {
  date: IsoDate;
  close: number;
}

/** End-of-day prices (Tiingo). */
export interface PriceProvider {
  /** Shown in the price log, e.g. 'tiingo'. */
  readonly name: string;
  /** Daily closes for `ticker` between the dates (inclusive). Empty when unknown. */
  dailyCloses(ticker: string, start: IsoDate, end: IsoDate): Promise<DailyClose[]>;
  /**
   * Latest closes for many tickers in as few requests as possible (optional).
   * Tickers it can't price in bulk are left out; callers fall back to
   * dailyCloses for those.
   */
  latestCloses?(tickers: string[]): Promise<Map<string, DailyClose>>;
  /** What a ticker is (optional): its kind of security and name; null when unknown. */
  describe?(ticker: string): Promise<SecurityDescription | null>;
}

export interface SecurityDescription {
  type: 'equity' | 'etf' | 'mutual fund';
  name: string | null;
}

export interface Quote {
  ticker: string;
  price: number;
  change: number;
  changePercent: number;
  previousClose: number;
  /** epoch ms of the last trade */
  time: number;
}

/** Live quotes (Tiingo by default, or Finnhub). */
export interface QuoteProvider {
  quote(ticker: string): Promise<Quote | null>;
  /** Many at once, in as few requests as possible (optional); unknown tickers are left out. */
  quotes?(tickers: string[]): Promise<Quote[]>;
}

/** Daily FX rates (Frankfurter / ECB). Returns rate converting 1 `base` into `quote`. */
export interface FxProvider {
  readonly name: string;
  rates(base: Currency, quote: Currency, start: IsoDate, end: IsoDate): Promise<{ date: IsoDate; rate: number }[]>;
}

/**
 * Wakes a runner for jobs (services/jobRunner.ts). The jobs table is the
 * record; this only says "run job X now (or after a delay)". A Cloudflare
 * Queue on Workers, the process's own loop on Node. A lost wake-up is
 * recovered by the sweep.
 */
export interface JobQueue {
  wake(ids: string[], delaySeconds?: number): Promise<void>;
}

export interface Deps {
  db: Db;
  config: Config;
  plaid: PlaidApi | null;
  prices: PriceProvider | null;
  quotes: QuoteProvider | null;
  fx: FxProvider | null;
  now: () => Date;
  jobQueue: JobQueue;
  /** Keep work running after the response is sent (ctx.waitUntil on Workers). */
  background: (work: Promise<unknown>) => void;
  /** Wait (e.g. for a lease); tests make it instant. */
  sleep: (ms: number) => Promise<void>;
}
