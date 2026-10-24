import { describe, expect, it } from 'vitest';
import { closeDayOf, lastClosedTradingDay, lastMarketClose, marketCloseAt } from './dates';

describe('market close', () => {
  it('is 4pm New York, in summer and winter time', () => {
    expect(new Date(marketCloseAt('2026-10-08')).toISOString()).toBe('2026-10-08T20:00:00.000Z'); // EDT
    expect(new Date(marketCloseAt('2026-12-01')).toISOString()).toBe('2026-12-01T21:00:00.000Z'); // EST
  });

  it("the last one is today's once it's passed, else yesterday's", () => {
    expect(new Date(lastMarketClose(new Date('2026-10-09T02:00:00Z'))).toISOString()).toBe('2026-10-08T20:00:00.000Z'); // 10pm on the 8th
    expect(new Date(lastMarketClose(new Date('2026-10-08T15:00:00Z'))).toISOString()).toBe('2026-10-07T20:00:00.000Z'); // 11am
  });
});

describe('trading days of instants', () => {
  const at = (iso: string) => Date.parse(iso);

  it('data fetched describes the last trading day whose close has passed', () => {
    expect(lastClosedTradingDay(at('2026-10-23T23:18:00Z'))).toBe('2026-10-23'); // Friday 7:18pm New York
    expect(lastClosedTradingDay(at('2026-10-24T10:00:00Z'))).toBe('2026-10-23'); // Saturday 6am
    expect(lastClosedTradingDay(at('2026-10-26T10:00:00Z'))).toBe('2026-10-23'); // Monday 6am
    expect(lastClosedTradingDay(at('2026-10-26T20:00:00Z'))).toBe('2026-10-26'); // Monday 4pm
  });

  it("a price's time is a day's close from that close until the next open", () => {
    expect(closeDayOf(at('2026-10-23T20:00:00Z'))).toBe('2026-10-23'); // Friday 4pm
    expect(closeDayOf(at('2026-10-26T13:29:00Z'))).toBe('2026-10-23'); // Monday 9:29am
    expect(closeDayOf(at('2026-10-26T13:30:00Z'))).toBeNull(); // Monday's open
    expect(closeDayOf(at('2026-10-23T19:59:00Z'))).toBeNull(); // Friday 3:59pm
    expect(closeDayOf(at('2026-12-01T21:00:00Z'))).toBe('2026-12-01'); // 4pm EST
    expect(closeDayOf(at('2026-12-01T20:30:00Z'))).toBeNull();
  });
});
