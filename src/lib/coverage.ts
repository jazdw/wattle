/** An account's stored history (GET /api/coverage), summed up: its span, its gaps, and the line under it on the Accounts page. */
import { addDays, type IsoDate } from '../../shared/dates';
import type { AccountCoverage, CoverageSource } from '../../shared/types';
import { longDate } from './format';

export const SOURCE_LABELS: Record<CoverageSource, string> = { files: 'Imported', bank: 'Plaid', you: 'Manual', new: 'This import' };
export const SOURCE_COLORS: Record<CoverageSource, string> = { files: 'var(--series-1)', bank: 'var(--series-3)', you: 'var(--series-4)', new: 'var(--series-2)' };

/** The first and last day of an account's history (balances or transactions), or null with none. */
export function historySpan(coverage: Pick<AccountCoverage, 'balances' | 'transactions'>): { from: IsoDate; to: IsoDate } | null {
  const dates = [...coverage.balances.flatMap((run) => [run.from, run.to]), ...coverage.transactions.map((day) => day.date)].sort();
  return dates.length > 0 ? { from: dates[0], to: dates.at(-1)! } : null;
}

/** Breaks between an account's balance runs: days it has no balance for. */
export function balanceGaps(coverage: Pick<AccountCoverage, 'balances'>): { from: IsoDate; to: IsoDate }[] {
  const runs = [...coverage.balances].sort((a, b) => a.from.localeCompare(b.from));
  return runs.slice(1).flatMap((run, index) => (run.from > addDays(runs[index].to, 1) ? [{ from: addDays(runs[index].to, 1), to: addDays(run.from, -1) }] : []));
}

/** The line under an account: the days it has balances and transactions for, its gaps, and a balance that's stopped updating. */
export function historySummary(coverage: AccountCoverage, today: IsoDate): string {
  const range = (from: string, to: string) => `${longDate(from)} – ${to >= today ? 'today' : longDate(to)}`;
  const runs = coverage.balances;
  const parts = [
    runs.length > 0 ? `Balances ${range(runs[0].from, runs.at(-1)!.to)}` : 'No balances',
    coverage.transactions.length > 0 ? `Transactions ${range(coverage.transactions[0].date, coverage.transactions.at(-1)!.date)}` : 'No transactions',
  ];
  const gaps = balanceGaps(coverage).length;
  if (gaps > 0) parts.push(`${gaps} ${gaps === 1 ? 'gap' : 'gaps'}`);
  if (coverage.unchangedSince) parts.push(`balance unchanged since ${longDate(coverage.unchangedSince)}`);
  return parts.join(' · ');
}

