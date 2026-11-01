import { describe, expect, it } from 'vitest';
import { accountKind, changeClass, longDate, money, quantity, relativeTime, shortDate } from './format';
import { foldSeries } from './series';

describe('format helpers', () => {
  it('names account kinds readably', () => {
    expect(accountKind('depository', 'checking')).toBe('Checking');
    expect(accountKind('depository', 'money market')).toBe('Money market');
    expect(accountKind('depository', 'cd')).toBe('CD');
    expect(accountKind('depository', 'hsa')).toBe('HSA');
    expect(accountKind('investment', '401k')).toBe('401(k)');
    expect(accountKind('investment', 'roth')).toBe('Roth IRA');
    expect(accountKind('investment', 'sep ira')).toBe('SEP IRA');
    expect(accountKind('credit', 'credit card')).toBe('Credit card');
    expect(accountKind('loan', 'student')).toBe('Student loan');
    expect(accountKind('depository', null)).toBe('Bank account');
    expect(accountKind('property', null)).toBe('Property');
  });

  it('formats values for display', () => {
    expect(money(null, 'USD')).toBe('—');
    expect(money(1_00, 'USD')).toBe('$1.00');
    expect(shortDate('2026-10-08')).toMatch(/Oct\s+8/);
    expect(longDate('2026-10-08')).toMatch(/2026/);
    // Fractional shares in full: 6 places, 8 below one unit (crypto), no trailing zeros.
    expect(quantity(1.23456)).toBe('1.23456');
    expect(quantity(1234.5678)).toBe('1,234.5678');
    expect(quantity(643.80867509953123)).toBe('643.808675');
    expect(quantity(0.00293644)).toBe('0.00293644');
    expect(quantity(213)).toBe('213');
    expect(changeClass(1)).toBe('text-positive');
    expect(changeClass(-1)).toBe('text-negative');
    expect(changeClass(0)).toBe('text-muted-foreground');
    expect(relativeTime(null)).toBe('never');
    expect(relativeTime(Date.now() - 5 * 60_000)).toBe('5m ago');
    expect(relativeTime(Date.now() - 3 * 3600_000)).toBe('3h ago');
    expect(relativeTime(Date.now() - 5 * 86400_000)).toBe('5d ago');
  });
});

describe('foldSeries', () => {
  const history = (count: number) => ({
    currency: 'USD' as const,
    group: 'account' as const,
    dates: ['2026-10-07', '2026-10-08'],
    series: Array.from({ length: count }, (_, index) => ({ key: `a${index}`, label: `A${index}`, values: [index, index === 0 ? null : index * 10], quality: [null, null] })),
  });

  it('keeps up to eight series with fixed palette slots', () => {
    const series = foldSeries(history(8));
    expect(series).toHaveLength(8);
    expect(series[0]).toMatchObject({ key: 'a7', color: 'var(--series-1)' });
  });

  it('folds the smallest series into Other beyond eight', () => {
    const series = foldSeries(history(10));
    expect(series).toHaveLength(8);
    const other = series.at(-1)!;
    expect(other).toMatchObject({ key: '__other', label: 'Other (3)' });
    expect(other.values).toEqual([0 + 1 + 2, 10 + 20]);
  });

  it('folds debts apart from accounts with money in them, so neither fold crosses zero', () => {
    const base = history(8);
    const owing = (key: string, values: (number | null)[]) => ({ key, label: key, values, quality: [null, null] });
    // A card owing $5 then paid off (still a debt), a loan, and a small cash account.
    const series = foldSeries({ ...base, series: [...base.series, owing('card', [-5, 0]), owing('loan', [-50, -40]), owing('cash', [3, 4])] });
    expect(series.map((item) => item.label).slice(-2)).toEqual(['Other (2)', 'Other debts (2)']);
    expect(series.at(-1)!.values).toEqual([-55, -40]);
    expect(series.at(-2)!.values).toEqual([3, 4]); // the cash account and A0 (no value on the 8th)
  });
});
