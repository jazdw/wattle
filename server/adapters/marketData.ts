/**
 * Market-data adapters:
 *  - Tiingo: end-of-day closes, including mutual fund NAVs (free tier is
 *    personal use only — fine for Wattle).
 *  - Finnhub: live quotes for US stocks and ETFs.
 *  - Frankfurter: daily ECB FX rates, no key.
 * Each implements a port from server/ports.ts so providers can be swapped.
 */
import type { Currency } from '../../shared/money';
import type { DailyClose, FxProvider, PriceProvider, Quote, QuoteProvider } from '../ports';

export function createTiingo(apiKey: string): PriceProvider {
  return {
    async dailyCloses(ticker, start, end) {
      const params = new URLSearchParams({ startDate: start, endDate: end, token: apiKey });
      const response = await fetch(
        `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(ticker.toLowerCase())}/prices?${params}`,
        { headers: { 'content-type': 'application/json' } },
      );
      if (response.status === 404) return [];
      if (!response.ok) throw new Error(`Tiingo ${ticker}: HTTP ${response.status}`);
      const rows = (await response.json()) as { date: string; close: number }[];
      return rows
        .filter((row) => typeof row.close === 'number')
        .map((row): DailyClose => ({ date: row.date.slice(0, 10), close: row.close }));
    },
  };
}

export function createFinnhub(apiKey: string): QuoteProvider {
  return {
    async quote(ticker) {
      const params = new URLSearchParams({ symbol: ticker.toUpperCase(), token: apiKey });
      const response = await fetch(`https://finnhub.io/api/v1/quote?${params}`);
      if (!response.ok) throw new Error(`Finnhub ${ticker}: HTTP ${response.status}`);
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
    async rates(base: Currency, quote: Currency, start, end) {
      const params = new URLSearchParams({ base, symbols: quote });
      const range = start === end ? start : `${start}..${end}`;
      const response = await fetch(`https://api.frankfurter.dev/v1/${range}?${params}`);
      if (!response.ok) throw new Error(`Frankfurter: HTTP ${response.status}`);
      const body = (await response.json()) as
        | { date: string; rates: Record<string, number> }
        | { rates: Record<string, Record<string, number>> };
      if ('date' in body) return [{ date: body.date, rate: body.rates[quote] }];
      return Object.entries(body.rates).map(([date, rates]) => ({ date, rate: rates[quote] }));
    },
  };
}
