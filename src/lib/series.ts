import type { HistoryResponse } from '../../shared/types';
import { MAX_SERIES, OTHER_COLOR, seriesColor } from './colors';

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  values: (number | null)[];
}

/** Keep the largest series and fold the rest into "Other" so colours never cycle. */
export function foldSeries(history: HistoryResponse, colorFor?: (key: string, index: number) => string): ChartSeries[] {
  const sorted = [...history.series].sort((a, b) => (b.values.at(-1) ?? 0) - (a.values.at(-1) ?? 0));
  const keep = sorted.length > MAX_SERIES + 1 ? sorted.slice(0, MAX_SERIES) : sorted;
  const rest = sorted.slice(keep.length);
  const result = keep.map((series, index) => ({
    key: series.key,
    label: series.label,
    color: colorFor ? colorFor(series.key, index) : seriesColor(index),
    values: series.values,
  }));
  if (rest.length > 0) {
    result.push({
      key: '__other',
      label: `Other (${rest.length})`,
      color: OTHER_COLOR,
      values: history.dates.map((_, position) =>
        rest.reduce<number | null>((sum, series) => {
          const value = series.values[position];
          return value === null ? sum : (sum ?? 0) + value;
        }, null),
      ),
    });
  }
  return result;
}

