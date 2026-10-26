import { describe, expect, it } from 'vitest';
import { dayQuality, leastFinal, mayReplace, type Quality } from './quality';

describe('which value may replace which', () => {
  it('trusts your values over the institution, and the institution over rebuilt and carried ones', () => {
    expect(mayReplace('import', 'snapshot')).toBe(true);
    expect(mayReplace('snapshot', 'import')).toBe(false); // a sync doesn't replace an import
    expect(mayReplace('snapshot', 'manual')).toBe(false);
    expect(mayReplace('rebuilt', 'snapshot')).toBe(false);
    for (const next of ['carried', 'rebuilt', 'snapshot', 'import', 'manual'] as const) expect(mayReplace(next, 'carried')).toBe(true);
  });

  it('lets the later of an import and an entry win', () => {
    expect(mayReplace('import', 'import')).toBe(true);
    expect(mayReplace('manual', 'import')).toBe(true);
    expect(mayReplace('import', 'manual')).toBe(true);
  });
});

describe('a day made of several values', () => {
  const quality = (source: Quality['source'], priceSource: Quality['priceSource'] = 'close', unmatched = false): Quality => ({ source, priceSource, unmatched });

  it('takes the least trusted source, the least final price, and unmatched if any part is', () => {
    expect(dayQuality([quality('snapshot'), quality('carried', 'provisional'), quality('import', null)])).toEqual(quality('carried', 'provisional'));
    expect(dayQuality([quality('rebuilt', 'close', true), quality('snapshot', 'institution')])).toEqual(quality('rebuilt', 'institution', true));
    expect(dayQuality([])).toBeNull();
  });

  it('counts a balance without a price as no price, not as the least final', () => {
    expect(leastFinal([null, 'close'])).toBe('close');
    expect(leastFinal([null])).toBeNull();
    expect(leastFinal(['close', 'institution', 'provisional'])).toBe('provisional');
  });
});
