import { describe, expect, it } from 'vitest';
import { lastMarketClose, marketCloseAt } from './dates';

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
