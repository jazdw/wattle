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
 * Unit price of a security on a date: market close for public tickers (cash
 * is 1), otherwise the institution's latest unit price.
 */
export function priceOn(security: PricedSecurity, date: IsoDate, closes: CloseLookup): PriceResult | null {
  if (isCashSecurity(security)) return { price: 1, source: 'close' };
  if (security.isPublic && security.ticker) {
    const close = closes(security.ticker, date);
    if (close !== null) return { price: close, source: 'close' };
  }
  if (security.lastPrice !== null) return { price: security.lastPrice, source: 'institution' };
  return null;
}
