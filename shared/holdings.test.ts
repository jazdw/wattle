import { describe, expect, it } from 'vitest';
import { holdingLabel, holdingParts, holdingSymbol, marketTicker } from './holdings';

describe('holding labels', () => {
  it('names one with a ticker by its ticker, and its name too when long', () => {
    const fund = { ticker: 'VTI', name: 'Vanguard Total Stock Market ETF' };
    expect(holdingLabel(fund)).toBe('VTI · Vanguard Total Stock Market ETF');
    expect(holdingLabel(fund, 'short')).toBe('VTI');
    expect(holdingLabel({ ticker: 'XYZ', name: 'XYZ' })).toBe('XYZ');
    expect(holdingLabel({ ticker: 'XYZ' })).toBe('XYZ');
  });

  it('names one stored under its CUSIP by its name, short or long', () => {
    const planFund = { ticker: '123456AB7', name: 'Example Target Retirement 2050 Fund' };
    expect(marketTicker(planFund)).toBeNull();
    expect(holdingSymbol(planFund)).toBe('123456AB7');
    expect(holdingLabel(planFund)).toBe('Example Target Retirement 2050 Fund');
    expect(holdingLabel(planFund, 'short')).toBe('Example Target Retirement 2050 Fund');
  });

  it('falls back to an identifier, then to saying it’s unknown', () => {
    expect(holdingLabel({ ticker: null, name: null, cusip: '912828XY1' })).toBe('912828XY1');
    expect(holdingLabel({ isin: 'US0000000001' }, 'short')).toBe('US0000000001');
    expect(holdingLabel({})).toBe('Unknown security');
  });
});

describe('holding parts', () => {
  it('splits the long label for two lines', () => {
    expect(holdingParts({ ticker: 'VTI', name: 'Vanguard Total Stock Market ETF' })).toEqual({ short: 'VTI', detail: 'Vanguard Total Stock Market ETF' });
    expect(holdingParts({ ticker: '123456AB7', name: 'Example Target Retirement 2050 Fund' })).toEqual({ short: 'Example Target Retirement 2050 Fund', detail: null });
  });
});
