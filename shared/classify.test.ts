import { describe, expect, it } from 'vitest';
import { categoryTotals, styleBreakdown } from './allocation';
import { suggestClassification } from './classify';

describe('suggestClassification', () => {
  it('uses seeded profiles', () => {
    const result = suggestClassification({ ticker: 'vtsax', name: null, type: 'mutual fund' });
    expect(result.source).toBe('seed');
    expect(result.classification.categories).toEqual({ us_stock: 1 });
  });

  it('resolves target-date funds into a stock/bond mix', () => {
    const { classification } = suggestClassification({ ticker: 'VFFVX', name: null, type: 'mutual fund' });
    const stocks = (classification.categories.us_stock ?? 0) + (classification.categories.intl_stock ?? 0) + (classification.categories.em_stock ?? 0);
    expect(stocks).toBeGreaterThan(0.85);
    expect(classification.categories.us_bond).toBeGreaterThan(0);
  });

  it('recognises non-public target-date trusts by name', () => {
    const result = suggestClassification({ ticker: null, name: 'Vanguard Target Retirement 2055 Trust II', type: 'mutual fund' });
    expect(result.needsReview).toBe(true);
    expect(result.classification.categories.us_stock).toBeGreaterThan(0.4);
  });

  it('classifies cash and bonds heuristically', () => {
    expect(suggestClassification({ ticker: 'CUR:USD', name: 'US Dollar', type: 'cash' }).classification.categories).toEqual({ cash: 1 });
    expect(suggestClassification({ ticker: 'XYZ', name: 'Core Bond Index', type: 'mutual fund' }).classification.categories).toEqual({ us_bond: 1 });
  });
});

describe('allocation look-through', () => {
  it('splits fund value into categories and style', () => {
    const positions = [
      { valueMinor: 100_00, classification: { categories: { us_stock: 0.6, us_bond: 0.4 }, sizes: { large: 1 }, styles: { growth: 1 } } },
      { valueMinor: 50_00, classification: { categories: { cash: 1 } } },
    ];
    const totals = categoryTotals(positions);
    expect(totals.us_stock).toBe(60_00);
    expect(totals.us_bond).toBe(40_00);
    expect(totals.cash).toBe(50_00);
    const style = styleBreakdown(positions);
    expect(style.equityTotal).toBe(60_00);
    expect(style.grid.large.growth).toBe(60_00);
  });
});
