import {
  CATEGORIES,
  EQUITY_CATEGORIES,
  SIZES,
  STYLES,
  normalizeWeights,
  type Category,
  type Classification,
  type Size,
  type Style,
} from './taxonomy';

/** A holding (or a whole account without holdings) valued in one currency. */
export interface Position {
  valueMinor: number;
  classification: Classification;
}

export type CategoryTotals = Record<Category, number>;

export function emptyCategoryTotals(): CategoryTotals {
  return Object.fromEntries(CATEGORIES.map((category) => [category, 0])) as CategoryTotals;
}

/** Look through every position into allocation categories. */
export function categoryTotals(positions: Position[]): CategoryTotals {
  const totals = emptyCategoryTotals();
  for (const position of positions) {
    const weights = normalizeWeights(position.classification.categories);
    const entries = Object.entries(weights) as [Category, number][];
    if (entries.length === 0) {
      totals.other += position.valueMinor;
      continue;
    }
    for (const [category, weight] of entries) totals[category] += position.valueMinor * weight;
  }
  for (const category of CATEGORIES) totals[category] = Math.round(totals[category]);
  return totals;
}

export type StyleGrid = Record<Size, Record<Style, number>>;

export interface StyleBreakdown {
  grid: StyleGrid;
  /** Equity value whose size or style is unknown. */
  unclassified: number;
  equityTotal: number;
}

/**
 * Equity look-through into a 3×3 size/style grid. Size and style splits are
 * treated as independent (a fund 70% large and 40% growth contributes 28% to
 * large-growth), which is the usual approximation without holdings-level data.
 */
export function styleBreakdown(positions: Position[]): StyleBreakdown {
  const grid = Object.fromEntries(
    SIZES.map((size) => [size, Object.fromEntries(STYLES.map((style) => [style, 0]))]),
  ) as StyleGrid;
  let unclassified = 0;
  let equityTotal = 0;

  for (const position of positions) {
    const categories = normalizeWeights(position.classification.categories);
    const equityWeight = EQUITY_CATEGORIES.reduce((sum, category) => sum + (categories[category] ?? 0), 0);
    const equityValue = position.valueMinor * equityWeight;
    if (equityValue === 0) continue;
    equityTotal += equityValue;

    const sizes = normalizeWeights(position.classification.sizes ?? {});
    const styles = normalizeWeights(position.classification.styles ?? {});
    if (Object.keys(sizes).length === 0 || Object.keys(styles).length === 0) {
      unclassified += equityValue;
      continue;
    }
    for (const size of SIZES) {
      for (const style of STYLES) {
        grid[size][style] += equityValue * (sizes[size] ?? 0) * (styles[style] ?? 0);
      }
    }
  }

  for (const size of SIZES) for (const style of STYLES) grid[size][style] = Math.round(grid[size][style]);
  return { grid, unclassified: Math.round(unclassified), equityTotal: Math.round(equityTotal) };
}
