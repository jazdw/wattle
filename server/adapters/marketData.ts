/**
 * Market-data adapters:
 *  - Tiingo: end-of-day closes, including mutual fund NAVs, and latest
 *    stock/ETF closes and live quotes in bulk via its IEX endpoint (free
 *    tier is personal use only — fine for Wattle).
 *  - Finnhub: live quotes for US stocks and ETFs, one request per ticker
 *    (the default live quote provider when FINNHUB_API_KEY is set; its free
 *    plan has no mutual funds or daily history, so closes come from Tiingo).
 *  - Frankfurter: daily ECB FX rates, no key.
 * Each implements a port from server/ports.ts so providers can be swapped.
 */
import { newYorkClock } from '../../shared/dates';
import type { Currency } from '../../shared/money';
import type { DailyClose, FxProvider, PriceProvider, Quote, QuoteProvider, SecurityDescription } from '../ports';

/** A provider answered with an HTTP error (429 means "too many requests"). */
export class ProviderHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(`${message}: HTTP ${status}`);
    this.name = 'ProviderHttpError';
    this.status = status;
  }
}

export function createTiingo(apiKey: string): PriceProvider {
  return {
    name: 'tiingo',
    async dailyCloses(ticker, start, end) {
      const params = new URLSearchParams({ startDate: start, endDate: end });
      // Keys go in headers, never URLs: URLs end up in request logs and traces.
      const response = await fetch(
        `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(ticker.toLowerCase())}/prices?${params}`,
        { headers: { 'content-type': 'application/json', authorization: `Token ${apiKey}` } },
      );
      if (response.status === 404) return [];
      if (!response.ok) throw new ProviderHttpError(`Tiingo ${ticker}`, response.status);
      const rows = (await response.json()) as { date: string; close: number }[];
      return rows
        .filter((row) => typeof row.close === 'number')
        .map((row): DailyClose => ({ date: row.date.slice(0, 10), close: row.close }));
    },

    // Tiingo's search gives each listing's asset type; the exact ticker,
    // preferring its US listing (VTI is also a Canadian stock).
    async describe(ticker) {
      const params = new URLSearchParams({ query: ticker.toUpperCase(), limit: '10' });
      const response = await fetch(`https://api.tiingo.com/tiingo/utilities/search?${params}`, {
        headers: { 'content-type': 'application/json', authorization: `Token ${apiKey}` },
      });
      if (!response.ok) throw new ProviderHttpError(`Tiingo search ${ticker}`, response.status);
      const rows = (await response.json()) as { ticker?: string; name?: string; assetType?: string; countryCode?: string }[];
      const matches = rows.filter((row) => row.ticker?.toUpperCase() === ticker.toUpperCase());
      const match = matches.find((row) => row.countryCode === 'US') ?? matches[0];
      const type = match ? ASSET_TYPES[match.assetType ?? ''] : undefined;
      return type ? { type, name: match!.name ?? null } : null;
    },

    // One request for many stocks/ETFs: Tiingo's IEX endpoint returns the
    // last price (tngoLast) with its timestamp. A price stamped after the
    // 16:00 New York close is that day's closing price. Mutual funds aren't
    // on IEX; callers fetch those one at a time with dailyCloses.
    async latestCloses(tickers) {
      const closes = new Map<string, DailyClose>();
      for (const row of await tiingoIex(apiKey, tickers)) {
        const clock = newYorkClock(new Date(row.timestamp));
        if (clock.minutes >= MARKET_CLOSE_MINUTES) closes.set(row.ticker, { date: clock.date, close: row.tngoLast });
      }
      return closes;
    },
  };
}

interface IexRow {
  ticker: string;
  timestamp: string;
  /** Tiingo's latest price: the last trade, or the bid/ask midpoint on the free tier. */
  tngoLast: number;
  prevClose: number | null;
}

/** Tiingo's IEX endpoint for many tickers, in as few requests as possible. */
async function tiingoIex(apiKey: string, tickers: string[]): Promise<IexRow[]> {
  const found: IexRow[] = [];
  for (let index = 0; index < tickers.length; index += BULK_TICKERS) {
    const chunk = tickers.slice(index, index + BULK_TICKERS).map((ticker) => ticker.toUpperCase());
    const params = new URLSearchParams({ tickers: chunk.join(',').toLowerCase() });
    const response = await fetch(`https://api.tiingo.com/iex/?${params}`, {
      headers: { 'content-type': 'application/json', authorization: `Token ${apiKey}` },
    });
    if (!response.ok) throw new ProviderHttpError('Tiingo IEX', response.status);
    const rows = (await response.json()) as { ticker?: string; timestamp?: string; tngoLast?: number | null; prevClose?: number | null }[];
    // Filter to what was asked for, in case the whole market comes back.
    const wanted = new Set(chunk);
    for (const row of rows) {
      const ticker = row.ticker?.toUpperCase();
      if (!ticker || !wanted.has(ticker) || typeof row.tngoLast !== 'number' || !row.timestamp) continue;
      found.push({ ticker, timestamp: row.timestamp, tngoLast: row.tngoLast, prevClose: row.prevClose ?? null });
    }
  }
  return found;
}

/** Live stock/ETF quotes from Tiingo: one request for all tickers. */
export function createTiingoQuotes(apiKey: string): QuoteProvider {
  const toQuote = (row: IexRow): Quote => {
    const previousClose = row.prevClose ?? row.tngoLast;
    const change = row.tngoLast - previousClose;
    return {
      ticker: row.ticker,
      price: row.tngoLast,
      change,
      changePercent: previousClose ? change / previousClose : 0,
      previousClose,
      time: Date.parse(row.timestamp),
    };
  };
  return {
    async quote(ticker) {
      const [row] = await tiingoIex(apiKey, [ticker]);
      return row ? toQuote(row) : null;
    },
    async quotes(tickers) {
      return (await tiingoIex(apiKey, tickers)).map(toQuote);
    },
  };
}

/** Tiingo's asset types, as Wattle's (Plaid's) security types. */
const ASSET_TYPES: Record<string, SecurityDescription['type']> = { Stock: 'equity', ETF: 'etf', 'Mutual Fund': 'mutual fund' };

/** Tickers per bulk request (keeps the URL short). */
const BULK_TICKERS = 100;
/** 16:00 in minutes past midnight, New York. */
const MARKET_CLOSE_MINUTES = 16 * 60;

export function createFinnhub(apiKey: string): QuoteProvider {
  return {
    async quote(ticker) {
      const params = new URLSearchParams({ symbol: ticker.toUpperCase() });
      const response = await fetch(`https://finnhub.io/api/v1/quote?${params}`, {
        headers: { 'x-finnhub-token': apiKey },
      });
      if (!response.ok) throw new ProviderHttpError(`Finnhub ${ticker}`, response.status);
      const body = (await response.json()) as { c: number; d: number | null; dp: number | null; pc: number; t: number };
      // Unknown symbols come back as all zeros.
      if (!body.c && !body.pc) return null;
      return {
        ticker: ticker.toUpperCase(),
        price: body.c,
        change: body.d ?? 0,
        changePercent: (body.dp ?? 0) / 100,
        previousClose: body.pc,
        time: body.t * 1000,
      } satisfies Quote;
    },
  };
}

export function createFrankfurter(): FxProvider {
  return {
    name: 'frankfurter',
    async rates(base: Currency, quote: Currency, start, end) {
      const params = new URLSearchParams({ base, symbols: quote });
      const range = start === end ? start : `${start}..${end}`;
      const response = await fetch(`https://api.frankfurter.dev/v1/${range}?${params}`);
      if (!response.ok) throw new ProviderHttpError('Frankfurter', response.status);
      const body = (await response.json()) as
        | { date: string; rates: Record<string, number> }
        | { rates: Record<string, Record<string, number>> };
      if ('date' in body) return [{ date: body.date, rate: body.rates[quote] }];
      return Object.entries(body.rates).map(([date, rates]) => ({ date, rate: rates[quote] }));
    },
  };
}
