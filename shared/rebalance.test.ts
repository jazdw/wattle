import { describe, expect, it } from 'vitest';
import { emptyCategoryTotals } from './allocation';
import { driftTable, fullRebalance, investNewCash } from './rebalance';

function totals(values: Record<string, number>) {
  return { ...emptyCategoryTotals(), ...values };
}

describe('driftTable', () => {
  it('reports drift, deltas and band breaches', () => {
    const rows = driftTable(totals({ us_stock: 70_00, us_bond: 30_00 }), { us_stock: 0.6, us_bond: 0.4 }, 5);
    const stock = rows.find((row) => row.category === 'us_stock')!;
    expect(stock.actual).toBeCloseTo(0.7);
    expect(stock.drift).toBeCloseTo(0.1);
    expect(stock.deltaMinor).toBe(-10_00);
    expect(stock.outOfBand).toBe(true);
  });

  it('includes targeted categories that are not held', () => {
    const rows = driftTable(totals({ us_stock: 100 }), { us_stock: 0.5, intl_stock: 0.5 }, 5);
    expect(rows.map((row) => row.category)).toEqual(['us_stock', 'intl_stock']);
  });
});

describe('fullRebalance', () => {
  it('buys and sells to target and nets to zero', () => {
    const trades = fullRebalance(totals({ us_stock: 80_00, us_bond: 20_00 }), { us_stock: 0.6, us_bond: 0.4 });
    expect(trades).toEqual([
      { category: 'us_bond', amountMinor: 20_00 },
      { category: 'us_stock', amountMinor: -20_00 },
    ]);
  });
});

describe('investNewCash', () => {
  it('fills only underweight categories when cash is short', () => {
    const trades = investNewCash(totals({ us_stock: 80_00, us_bond: 20_00 }), { us_stock: 0.6, us_bond: 0.4 }, 10_00);
    expect(trades).toEqual([{ category: 'us_bond', amountMinor: 10_00 }]);
  });

  it('spreads leftover cash by target once balanced and keeps the exact total', () => {
    const trades = investNewCash(totals({ us_stock: 60_00, us_bond: 40_00 }), { us_stock: 0.6, us_bond: 0.4 }, 101);
    expect(trades.reduce((sum, trade) => sum + trade.amountMinor, 0)).toBe(101);
    expect(trades[0]).toEqual({ category: 'us_stock', amountMinor: 61 });
  });
});
