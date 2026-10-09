import { describe, expect, it } from 'vitest';
import { addDays, dateRange, isIsoDate, marketDate } from './dates';
import { convertMinor, formatMoney, formatPercent, fromMinor, fxRate, isCurrency, toMinor } from './money';

describe('money', () => {
  it('converts between units and currencies', () => {
    expect(toMinor(12.345)).toBe(1235);
    expect(fromMinor(1235)).toBe(12.35);
    expect(fxRate({ 'USD->AUD': 1.5 }, 'USD', 'AUD')).toBe(1.5);
    expect(fxRate({ 'USD->AUD': 1.5 }, 'AUD', 'USD')).toBeCloseTo(1 / 1.5);
    expect(fxRate({}, 'USD', 'USD')).toBe(1);
    expect(fxRate({}, 'USD', 'AUD')).toBeNull();
    expect(convertMinor(100_00, 'AUD', 'USD', { 'USD->AUD': 2 })).toBe(50_00);
    expect(convertMinor(100_00, 'AUD', 'USD', {})).toBe(100_00);
    expect(isCurrency('AUD')).toBe(true);
    expect(isCurrency('EUR')).toBe(false);
  });

  it('formats', () => {
    expect(formatMoney(123456_78, 'USD')).toBe('$123,457');
    expect(formatMoney(123456_78, 'USD', { cents: true })).toBe('$123,456.78');
    expect(formatMoney(1_250_000_00, 'USD', { compact: true })).toBe('$1.3M');
    expect(formatMoney(5_00, 'USD', { signed: true })).toBe('+$5');
    expect(formatMoney(5_00, 'AUD')).toBe('$5');
    expect(formatPercent(0.1234)).toBe('12.3%');
    expect(formatPercent(-0.05, 0, true)).toBe('-5%');
  });
});

describe('dates', () => {
  it('uses the New York calendar date for snapshots', () => {
    expect(marketDate(new Date('2026-10-09T02:00:00Z'))).toBe('2026-10-08'); // EDT
    expect(marketDate(new Date('2026-12-09T04:30:00Z'))).toBe('2026-12-08'); // EST
    expect(marketDate(new Date('2026-12-09T05:30:00Z'))).toBe('2026-12-09');
  });

  it('does date arithmetic across months and leap years', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(dateRange('2026-12-30', '2027-01-02')).toEqual(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
    expect(dateRange('2026-01-02', '2026-01-01')).toEqual([]);
    expect(isIsoDate('2026-10-08')).toBe(true);
    expect(isIsoDate('08/10/2026')).toBe(false);
  });
});
