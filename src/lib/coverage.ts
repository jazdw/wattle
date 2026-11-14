/** An account's stored history (GET /api/coverage), summed up: its span, its gaps, the line under it on the Accounts page, and its transactions as runs to draw. */
import { addDays, mergeSpans, type IsoDate } from '../../shared/dates';
import type { AccountCoverage, CoverageSource, TransactionRange } from '../../shared/types';
import { longDate } from './format';

export const SOURCE_LABELS: Record<CoverageSource, string> = { files: 'Imported', bank: 'Plaid', you: 'Manual', new: 'This import' };
export const SOURCE_COLORS: Record<CoverageSource, string> = { files: 'var(--series-1)', bank: 'var(--series-3)', you: 'var(--series-4)', new: 'var(--series-2)' };

/** Whose transactions count on a day more than one source covers: a file being imported, then your files, then the institution's (server/services/importedRecord.ts). */
const PRECEDENCE: CoverageSource[] = ['new', 'files', 'bank', 'you'];

type Span = { from: IsoDate; to: IsoDate };

/** The first and last day of an account's history (balances or transactions), or null with none. */
export function historySpan(coverage: Pick<AccountCoverage, 'balances' | 'transactions'>): Span | null {
  const dates = [...coverage.balances, ...coverage.transactions].flatMap((run) => [run.from, run.to]).sort();
  return dates.length > 0 ? { from: dates[0], to: dates.at(-1)! } : null;
}

/** Days between the spans that none of them covers. */
function gaps(spans: Span[]): Span[] {
  const merged = mergeSpans(spans);
  return merged.slice(1).map((span, index) => ({ from: addDays(merged[index].to, 1), to: addDays(span.from, -1) }));
}

/** Breaks between an account's balance runs: days it has no balance for. */
export function balanceGaps(coverage: Pick<AccountCoverage, 'balances'>): Span[] {
  return gaps(coverage.balances);
}

/** Days between the first and last an account's transactions cover that no source covers. */
export function transactionGaps(coverage: Pick<AccountCoverage, 'transactions'>): Span[] {
  return gaps(coverage.transactions);
}

/** A run of an account's transaction days drawn in one source's colour. */
export interface TransactionRun {
  from: IsoDate;
  to: IsoDate;
  /** The source whose transactions count on these days. */
  source: CoverageSource;
  /** Its transactions on these days; null where that's not known (a stored range cut by a file being imported). */
  count: number | null;
}

/**
 * Transaction ranges as runs to draw, like balances: each day takes the
 * source whose transactions count on it (PRECEDENCE); days no range covers
 * are left out. A file being imported is added as `new` (its `covers`), to
 * show it beside what's stored.
 */
export function transactionRuns(ranges: (Omit<TransactionRange, 'count'> & { count: number | null })[]): TransactionRun[] {
  const cuts = [...new Set(ranges.flatMap((range) => [range.from, addDays(range.to, 1)]))].sort();
  const runs: (TransactionRun & { covering: typeof ranges })[] = [];
  for (const [index, from] of cuts.slice(0, -1).entries()) {
    const to = addDays(cuts[index + 1], -1);
    const covering = ranges.filter((range) => range.from <= from && range.to >= to);
    if (covering.length === 0) continue;
    const source = PRECEDENCE.find((candidate) => covering.some((range) => range.source === candidate))!;
    const last = runs.at(-1);
    if (last && last.source === source && addDays(last.to, 1) === from) {
      last.to = to;
      last.covering = [...new Set([...last.covering, ...covering])];
    } else runs.push({ from, to, source, count: null, covering });
  }
  return runs.map(({ covering, ...run }) => {
    const own = covering.filter((range) => range.source === run.source);
    const whole = own.every((range) => range.from >= run.from && range.to <= run.to && range.count !== null);
    return { ...run, count: whole ? own.reduce((sum, range) => sum + range.count!, 0) : null };
  });
}

const gapCount = (count: number) => `${count} ${count === 1 ? 'gap' : 'gaps'}`;

/** The line under an account: the days it has balances and transactions for, each with its gaps, and a balance that's stopped updating. */
export function historySummary(coverage: AccountCoverage, today: IsoDate): string {
  const range = (from: string, to: string) => `${longDate(from)} – ${to >= today ? 'today' : longDate(to)}`;
  const parts: string[] = [];
  const runs = coverage.balances;
  if (runs.length === 0) parts.push('No balances');
  else {
    parts.push(`Balances ${range(runs[0].from, runs.at(-1)!.to)}`);
    const balanceGapCount = balanceGaps(coverage).length;
    if (balanceGapCount > 0) parts.push(gapCount(balanceGapCount));
  }
  const covered = mergeSpans(coverage.transactions);
  if (covered.length === 0) parts.push('No transactions');
  else {
    parts.push(`Transactions ${range(covered[0].from, covered.at(-1)!.to)}`);
    const transactionGapCount = transactionGaps(coverage).length;
    if (transactionGapCount > 0) parts.push(gapCount(transactionGapCount));
  }
  if (coverage.unchangedSince) parts.push(`balance unchanged since ${longDate(coverage.unchangedSince)}`);
  return parts.join(' · ');
}
