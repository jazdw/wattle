/** The date ranges the charts and lists offer, and the first day of each (the server's and the pages' alike). */
import { addDays, type IsoDate } from './dates';

export const RANGES = ['1M', '3M', '6M', 'YTD', '1Y', '2Y', 'ALL'] as const;
export type Range = (typeof RANGES)[number];

export const RANGE_LABELS: Record<Range, string> = { '1M': '1M', '3M': '3M', '6M': '6M', YTD: 'YTD', '1Y': '1Y', '2Y': '2Y', ALL: 'All' };

const DAYS_BACK: Partial<Record<Range, number>> = { '1M': 30, '3M': 91, '6M': 182, '1Y': 365, '2Y': 730 };

/** A range's first day ending on `end`; null for All, which starts at the first stored value. */
export function fixedRangeStart(range: Range, end: IsoDate): IsoDate | null {
  if (range === 'ALL') return null;
  if (range === 'YTD') return `${end.slice(0, 4)}-01-01` as IsoDate;
  return addDays(end, -DAYS_BACK[range]!);
}
