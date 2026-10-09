import { describe, expect, it } from 'vitest';
import { changeClass, longDate, money, quantity, relativeTime, shortDate } from './format';
import { foldSeries } from './series';

describe('format helpers', () => {
  it('formats values for display', () => {
    expect(money(null, 'USD')).toBe('—');
    expect(money(1_00, 'USD')).toBe('$1');
    expect(shortDate('2026-10-08')).toMatch(/Oct\s+8/);
    expect(longDate('2026-10-08')).toMatch(/2026/);
    expect(quantity(1.23456)).toBe('1.2346');
    expect(quantity(1234.5678)).toBe('1,234.57');
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
    estimated: [false, false],
    series: Array.from({ length: count }, (_, index) => ({ key: `a${index}`, label: `A${index}`, values: [index, index === 0 ? null : index * 10] })),
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
});
