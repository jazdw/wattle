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

describe('heuristics', () => {
  const guess = (name: string, type: string | null = 'mutual fund', extra: Record<string, unknown> = {}) =>
    suggestClassification({ ticker: null, name, type, ...extra }).classification;

  it('recognises common fund names', () => {
    expect(guess('Emerging Markets Index').categories).toEqual({ em_stock: 1 });
    expect(guess('International Growth Fund').categories.intl_stock).toBeGreaterThan(0.5);
    expect(guess('Global Aggregate Bond').categories).toEqual({ intl_bond: 1 });
    expect(guess('US REIT Index').categories).toEqual({ real_estate: 1 });
    expect(guess('Stable Value Fund').categories).toEqual({ cash: 1 });
    expect(guess('Bitcoin', 'cryptocurrency').categories).toEqual({ crypto: 1 });
    expect(guess('Call option', 'derivative').categories).toEqual({ other: 1 });
    expect(guess('Some ASX Fund', 'etf', { currency: 'AUD' }).categories).toEqual({ au_stock: 1 });
  });

  it('infers size and style from names', () => {
    expect(guess('Small Cap Value Index')).toMatchObject({ sizes: { small: 0.8, mid: 0.2 }, styles: { value: 0.85, blend: 0.15 } });
    expect(guess('Mid Cap Growth')).toMatchObject({ sizes: { mid: 0.85 }, styles: { growth: 0.85 } });
    expect(guess('S&P 500 Index')).toMatchObject({ sizes: { large: 0.8 } });
    expect(guess('Mystery Fund').sizes).toBeUndefined();
  });

  it('treats single stocks as US stocks without review', () => {
    const result = suggestClassification({ ticker: 'AAPL', name: 'Apple Inc.', type: 'equity' });
    expect(result).toMatchObject({ classification: { categories: { us_stock: 1 } }, needsReview: false });
  });

  it('weights size/style of fund-of-funds by their stock portion', () => {
    const vt = suggestClassification({ ticker: 'VT', name: null, type: 'etf' }).classification;
    expect(Object.values(vt.sizes!).reduce((sum, value) => sum + (value ?? 0), 0)).toBeCloseTo(1);
    const vdhg = suggestClassification({ ticker: 'VDHG', name: null, type: 'etf' }).classification;
    expect(vdhg.categories.au_stock).toBeGreaterThan(0.3);
  });
});
