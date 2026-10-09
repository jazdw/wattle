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
  /** Comma-separated allow-list from the environment (joins the default household). */
  allowedEmails: string[];
  /** LOCAL DEVELOPMENT ONLY: emails that can sign in without Google on a private host. */
  devLoginEmails: string[];
  googleClientId?: string;
  googleClientSecret?: string;
  /** base64-encoded 32-byte key(s) for encrypting aggregator tokens: "v1:<key>[,v0:<key>]" or just "<key>". */
  tokenEncKey?: string;
  /** Shared secret for /api/admin/* (cron fallbacks, manual reruns). */
  adminToken?: string;
}

export interface DailyClose {
  date: IsoDate;
  close: number;
}

/** End-of-day prices (Tiingo). */
export interface PriceProvider {
  /** Daily closes for `ticker` between the dates (inclusive). Empty when unknown. */
  dailyCloses(ticker: string, start: IsoDate, end: IsoDate): Promise<DailyClose[]>;
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

/** Live quotes (Finnhub). */
export interface QuoteProvider {
  quote(ticker: string): Promise<Quote | null>;
}

/** Daily FX rates (Frankfurter / ECB). Returns rate converting 1 `base` into `quote`. */
export interface FxProvider {
  rates(base: Currency, quote: Currency, start: IsoDate, end: IsoDate): Promise<{ date: IsoDate; rate: number }[]>;
}

export interface Deps {
  db: Db;
  config: Config;
  plaid: PlaidApi | null;
  prices: PriceProvider | null;
  quotes: QuoteProvider | null;
  fx: FxProvider | null;
  now: () => Date;
  /** Keep work running after the response is sent (ctx.waitUntil on Workers). */
  background: (work: Promise<unknown>) => void;
}
