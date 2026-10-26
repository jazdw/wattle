/**
 * Where each day's value came from. Every daily balance and holding row says
 * how it was known (`source`), how it was priced (`priceSource`) and whether a
 * rebuild of it failed to reconcile (`unmatched`). The trust order lives here
 * and only here: a write replaces a row only if its source is trusted at least
 * as much, so your imports and entries beat anything from Plaid, and a value
 * carried forward over a gap gives way to anything better.
 */

export const DAILY_SOURCES = [
  /** Copied forward from the day before (a sync was missed). */
  'carried',
  /** Worked out from transactions, or from an institution's balance history. */
  'rebuilt',
  /** The institution's holdings or balance that day (a sync), or a manual account's holdings. */
  'snapshot',
  /** From a file you imported. */
  'import',
  /** Entered by you. */
  'manual',
] as const;
export type DailySource = (typeof DAILY_SOURCES)[number];

export const PRICE_SOURCES = [
  /** The market's close (or a fund's NAV) for the day. */
  'close',
  /** The last close before the day's, until the day's own exists. */
  'provisional',
  /** The institution's price, with no market close for the day. */
  'institution',
] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

export interface Quality {
  source: DailySource;
  /** Null for a value without a price (a balance). */
  priceSource: PriceSource | null;
  /** Rebuilt from transactions that don't reconcile with what's known. */
  unmatched: boolean;
}

/** Higher is trusted more. Imports and entries rank equally: the later one wins. */
export const TRUST: Record<DailySource, number> = { carried: 0, rebuilt: 1, snapshot: 2, import: 3, manual: 3 };

export function trust(source: DailySource): number {
  return TRUST[source];
}

/** Whether a value from `next` may replace one from `current`. */
export function mayReplace(next: DailySource, current: DailySource): boolean {
  return trust(next) >= trust(current);
}

/** Least final first: a provisional price makes a total provisional, and so on. */
const PRICE_ORDER: (PriceSource | null)[] = ['provisional', 'institution', 'close', null];

/** The least final of several prices (a day's total of holdings). */
export function leastFinal(prices: (PriceSource | null)[]): PriceSource | null {
  return prices.reduce<PriceSource | null>((least, price) => (PRICE_ORDER.indexOf(price) < PRICE_ORDER.indexOf(least) ? price : least), null);
}

/** The quality of a value made of several (a day's total): the least trusted source, the least final price, unmatched if any is. */
export function dayQuality(parts: Quality[]): Quality | null {
  if (parts.length === 0) return null;
  let quality = parts[0];
  for (const part of parts.slice(1)) {
    quality = {
      source: trust(part.source) < trust(quality.source) ? part.source : quality.source,
      priceSource: leastFinal([quality.priceSource, part.priceSource]),
      unmatched: quality.unmatched || part.unmatched,
    };
  }
  return quality;
}
