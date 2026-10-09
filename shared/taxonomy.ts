/**
 * Asset classification used for allocation, targets and the style view.
 *
 * A security is described by weight vectors (each summing to 1): how much of
 * it is in each allocation category, and — for the equity part — how that
 * equity splits by company size and by value/growth style. A target-date fund
 * is spread across several categories; VTSAX is ~100% US stocks spread across
 * sizes.
 */

export const CATEGORIES = [
  'us_stock',
  'intl_stock',
  'em_stock',
  'au_stock',
  'us_bond',
  'intl_bond',
  'cash',
  'real_estate',
  'crypto',
  'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  us_stock: 'US stocks',
  intl_stock: 'International stocks',
  em_stock: 'Emerging markets',
  au_stock: 'Australian stocks',
  us_bond: 'US bonds',
  intl_bond: 'International bonds',
  cash: 'Cash',
  real_estate: 'Real estate',
  crypto: 'Crypto',
  other: 'Other',
};

/** Categories that count as equity for the size/style breakdown. */
export const EQUITY_CATEGORIES: readonly Category[] = ['us_stock', 'intl_stock', 'em_stock', 'au_stock'];

export const SIZES = ['large', 'mid', 'small'] as const;
export type Size = (typeof SIZES)[number];

export const STYLES = ['value', 'blend', 'growth'] as const;
export type Style = (typeof STYLES)[number];

export type Weights<K extends string> = Partial<Record<K, number>>;

export interface Classification {
  categories: Weights<Category>;
  /** Equity size split; omitted when unknown or not equity. */
  sizes?: Weights<Size>;
  /** Equity style split; omitted when unknown or not equity. */
  styles?: Weights<Style>;
}

export type ClassificationSource = 'seed' | 'heuristic' | 'user';

/** Normalise weights so they sum to 1, dropping zero/negative entries. */
export function normalizeWeights<K extends string>(weights: Weights<K>): Weights<K> {
  const entries = Object.entries(weights).filter(
    (entry): entry is [K, number] => typeof entry[1] === 'number' && entry[1] > 0,
  );
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (total <= 0) return {};
  return Object.fromEntries(entries.map(([key, value]) => [key, value / total])) as Weights<K>;
}
