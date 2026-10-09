import type { Category } from '../../shared/taxonomy';

/**
 * Chart colours come from the validated 8-slot categorical palette (CSS
 * variables --series-1..8 in index.css, with selected dark-mode steps). Slot
 * ORDER is what keeps adjacent stacked series distinguishable for colour-blind
 * readers, so categories map to slots in taxonomy order and stack in that
 * order. Crypto/other/liabilities are neutral greys.
 */
export const CATEGORY_COLORS: Record<Category | 'liabilities', string> = {
  us_stock: 'var(--series-1)',
  intl_stock: 'var(--series-2)',
  em_stock: 'var(--series-3)',
  au_stock: 'var(--series-4)',
  us_bond: 'var(--series-5)',
  intl_bond: 'var(--series-6)',
  cash: 'var(--series-7)',
  real_estate: 'var(--series-8)',
  crypto: 'var(--series-neutral-dark)',
  other: 'var(--series-neutral)',
  liabilities: 'var(--series-neutral-dark)',
};

/** Max distinct series before the rest fold into "Other". */
export const MAX_SERIES = 7;

/** Colour for the n-th series (accounts, holdings). Index ≥ 8 should have been folded. */
export function seriesColor(index: number): string {
  return index < 8 ? `var(--series-${index + 1})` : 'var(--series-neutral)';
}

export const OTHER_COLOR = 'var(--series-neutral)';
