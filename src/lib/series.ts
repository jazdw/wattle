import type { HistoryResponse } from '../../shared/types';
import { MAX_SERIES, OTHER_COLOR, OTHER_DEBTS_COLOR, seriesColor } from './colors';

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  values: (number | null)[];
}

/** What a series is mostly: owed (below zero) by its latest value that isn't zero. */
function owed(values: (number | null)[]): boolean {
  const latest = [...values].reverse().find((value) => value !== null && value !== 0);
  return latest !== undefined && latest !== null && latest < 0;
}

/** Each day's sum of some series (null where none has a value). */
function sum(history: HistoryResponse, series: HistoryResponse['series']): (number | null)[] {
  return history.dates.map((_, position) =>
    series.reduce<number | null>((total, item) => {
      const value = item.values[position];
      return value === null ? total : (total ?? 0) + value;
    }, null),
  );
}

/**
 * Keep the largest series and fold the rest so colours never cycle: accounts
 * with money in them into "Other", debts into "Other debts", so neither fold
 * mixes the two and crosses zero (stacked, a series that crosses zero has to
 * be drawn in parts, see stackAreas).
 */
export function foldSeries(history: HistoryResponse, colorFor?: (key: string, index: number) => string): ChartSeries[] {
  const sorted = [...history.series].sort((a, b) => (b.values.at(-1) ?? 0) - (a.values.at(-1) ?? 0));
  const keep = sorted.length > MAX_SERIES + 1 ? sorted.slice(0, MAX_SERIES) : sorted;
  const rest = sorted.slice(keep.length);
  const result: ChartSeries[] = keep.map((series, index) => ({
    key: series.key,
    label: series.label,
    color: colorFor ? colorFor(series.key, index) : seriesColor(index),
    values: series.values,
  }));
  const debts = rest.filter((series) => owed(series.values));
  const assets = rest.filter((series) => !owed(series.values));
  if (assets.length > 0) result.push({ key: '__other', label: `Other (${assets.length})`, color: OTHER_COLOR, values: sum(history, assets) });
  if (debts.length > 0) result.push({ key: '__other_debts', label: `Other debts (${debts.length})`, color: OTHER_DEBTS_COLOR, values: sum(history, debts) });
  return result;
}

export interface StackedArea extends ChartSeries {
  /** Drawn only where it isn't zero: gaps instead of joining across them. */
  gaps?: boolean;
}

/**
 * The areas to draw. Stacked by sign, a series is drawn above zero or below
 * it, and recharts puts a value of exactly zero above: a series that crosses
 * zero (a fold of small accounts mixing cards and cash, an overdrawn account)
 * is drawn as its parts above and below zero, and a series below zero (a
 * card) is left out where it's zero, so nothing jumps across the stack or
 * outlines the top of it at zero.
 */
export function stackAreas(series: ChartSeries[], stacked: boolean): StackedArea[] {
  if (!stacked) return series;
  const part = (values: (number | null)[], keep: (value: number) => boolean) => values.map((value) => (value !== null && keep(value) ? value : null));
  return series.flatMap((item): StackedArea[] => {
    const positive = item.values.some((value) => value !== null && value > 0);
    const negative = item.values.some((value) => value !== null && value < 0);
    if (!negative) return [item];
    if (!positive) return [{ ...item, values: part(item.values, (value) => value < 0), gaps: true }];
    return [
      { ...item, values: part(item.values, (value) => value > 0), gaps: true },
      { ...item, key: `${item.key}:below`, values: part(item.values, (value) => value < 0), gaps: true },
    ];
  });
}
