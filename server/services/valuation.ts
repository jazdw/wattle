import type { IsoDate } from '../../shared/dates';
import type { PriceResult } from './backfillCore';
import type { CloseLookup } from './pricing';

export interface PricedSecurity {
  ticker: string | null;
  type: string | null;
  isPublic: boolean;
  lastPrice: number | null;
  lastPriceDate: string | null;
}

export function isCashSecurity(security: Pick<PricedSecurity, 'ticker' | 'type'>): boolean {
  return security.type === 'cash' || (security.ticker ?? '').startsWith('CUR:');
}

/**
 * Unit price of a security on a date: market close for public tickers,
 * otherwise the institution's latest unit price (flagged as a stand-in when
 * it isn't from that day).
 */
export function priceOn(security: PricedSecurity, date: IsoDate, closes: CloseLookup): PriceResult | null {
  if (isCashSecurity(security)) return { price: 1, estimated: false };
  if (security.isPublic && security.ticker) {
    const close = closes(security.ticker, date);
    if (close !== null) return { price: close, estimated: false };
  }
  if (security.lastPrice !== null) {
    // The latest institution price is the best value from its date onward;
    // used for earlier days it's a stand-in.
    return { price: security.lastPrice, estimated: !security.lastPriceDate || date < security.lastPriceDate };
  }
  return null;
}
