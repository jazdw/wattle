import type { CategoryTotals } from './allocation';
import { CATEGORIES, normalizeWeights, type Category, type Weights } from './taxonomy';

export interface DriftRow {
  category: Category;
  valueMinor: number;
  /** Current share of the total, 0–1. */
  actual: number;
  /** Target share, 0–1. */
  target: number;
  /** actual − target. */
  drift: number;
  /** Money to add (positive) or remove (negative) to hit the target exactly. */
  deltaMinor: number;
  /** True when |drift| exceeds the tolerance band. */
  outOfBand: boolean;
}

/**
 * Compare current category totals with a target. Categories that are neither
 * held nor targeted are left out. `bandPct` is an absolute band in percentage
 * points (5 = ±5%).
 */
export function driftTable(
  current: CategoryTotals,
  targetWeights: Weights<Category>,
  bandPct: number,
): DriftRow[] {
  const target = normalizeWeights(targetWeights);
  const total = CATEGORIES.reduce((sum, category) => sum + current[category], 0);
  const band = bandPct / 100;

  return CATEGORIES.filter((category) => current[category] !== 0 || (target[category] ?? 0) > 0).map(
    (category) => {
      const valueMinor = current[category];
      const actual = total > 0 ? valueMinor / total : 0;
      const targetShare = target[category] ?? 0;
      const drift = actual - targetShare;
      return {
        category,
        valueMinor,
        actual,
        target: targetShare,
        drift,
        deltaMinor: Math.round(targetShare * total - valueMinor),
        outOfBand: Math.abs(drift) > band,
      };
    },
  );
}

export interface Trade {
  category: Category;
  /** Positive = buy, negative = sell. */
  amountMinor: number;
}

/** Full rebalance: buy and sell so every category lands exactly on target. */
export function fullRebalance(current: CategoryTotals, targetWeights: Weights<Category>): Trade[] {
  return driftTable(current, targetWeights, 0)
    .filter((row) => row.deltaMinor !== 0)
    .map((row) => ({ category: row.category, amountMinor: row.deltaMinor }))
    .sort((a, b) => b.amountMinor - a.amountMinor);
}

/**
 * Buy-only rebalance: spread `cashMinor` of new money across underweight
 * categories without selling anything. Shortfalls (relative to the target at
 * the new total) are filled proportionally; once every category is at or
 * above target, any remaining cash is split by target weight.
 */
export function investNewCash(
  current: CategoryTotals,
  targetWeights: Weights<Category>,
  cashMinor: number,
): Trade[] {
  const target = normalizeWeights(targetWeights);
  const targeted = (Object.keys(target) as Category[]).filter((category) => (target[category] ?? 0) > 0);
  if (cashMinor <= 0 || targeted.length === 0) return [];

  const newTotal = CATEGORIES.reduce((sum, category) => sum + current[category], 0) + cashMinor;
  const shortfalls = targeted.map((category) => ({
    category,
    shortfall: Math.max(0, (target[category] ?? 0) * newTotal - current[category]),
  }));
  const totalShortfall = shortfalls.reduce((sum, row) => sum + row.shortfall, 0);

  const raw = new Map<Category, number>();
  if (totalShortfall >= cashMinor) {
    for (const row of shortfalls) raw.set(row.category, (row.shortfall / totalShortfall) * cashMinor);
  } else {
    const leftover = cashMinor - totalShortfall;
    for (const row of shortfalls) {
      raw.set(row.category, row.shortfall + leftover * (target[row.category] ?? 0));
    }
  }

  // Round to cents while keeping the exact total (largest remainder).
  const floored = [...raw.entries()].map(([category, amount]) => ({
    category,
    amountMinor: Math.floor(amount),
    remainder: amount - Math.floor(amount),
  }));
  let missing = cashMinor - floored.reduce((sum, row) => sum + row.amountMinor, 0);
  for (const row of [...floored].sort((a, b) => b.remainder - a.remainder)) {
    if (missing <= 0) break;
    row.amountMinor += 1;
    missing -= 1;
  }

  return floored
    .filter((row) => row.amountMinor > 0)
    .map(({ category, amountMinor }) => ({ category, amountMinor }))
    .sort((a, b) => b.amountMinor - a.amountMinor);
}
