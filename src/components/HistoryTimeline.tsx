/**
 * An account's history at a glance: its balances as a bar coloured by where
 * each run of days came from (your files, the institution, you; hatched where
 * Wattle filled them, empty where there are none), and its transactions as
 * a mark on each day that has any. Plain data in, so the Accounts page shows
 * what's stored and the import page can add a file's days (`new`) beside it.
 */
import { useState } from 'react';
import type { IsoDate } from '../../shared/dates';
import type { AccountCoverage, CoverageSource } from '../../shared/types';
import { historySpan, SOURCE_COLORS, SOURCE_LABELS } from '../lib/coverage';
import { longDate } from '../lib/format';

const DAY_MS = 86_400_000;
const time = (date: string) => Date.parse(`${date}T00:00:00Z`);
const monthYear = (date: string, month: boolean) => new Date(time(date)).toLocaleDateString(undefined, { ...(month ? { month: 'short' } : {}), year: 'numeric', timeZone: 'UTC' });

/** Labels along the axis: months, quarters, half-years or years, as few as read well. */
function axisMarks(from: IsoDate, to: IsoDate): { date: IsoDate; label: string }[] {
  const months = (time(to) - time(from)) / DAY_MS / 30.4;
  const step = months <= 6 ? 1 : months <= 18 ? 3 : months <= 36 ? 6 : 12;
  const start = new Date(time(from));
  const marks: { date: IsoDate; label: string }[] = [];
  for (let month = start.getUTCMonth() + 1; ; month++) {
    const date = new Date(Date.UTC(start.getUTCFullYear(), month, 1)).toISOString().slice(0, 10) as IsoDate;
    if (date > to) break;
    const index = new Date(time(date)).getUTCMonth();
    if (index % step === 0) marks.push({ date, label: monthYear(date, step < 12) });
  }
  return marks;
}

export function HistoryTimeline({ coverage, today }: { coverage: Pick<AccountCoverage, 'balances' | 'transactions' | 'unchangedSince'>; today: IsoDate }) {
  const [detail, setDetail] = useState<string | null>(null);
  const span = historySpan(coverage);
  if (!span) return <p className="text-xs text-muted-foreground">No history stored yet.</p>;
  const from = span.from;
  const to = span.to > today ? span.to : today;
  const days = (time(to) - time(from)) / DAY_MS + 1;
  const left = (date: string) => ((time(date) - time(from)) / DAY_MS / days) * 100;
  const width = (start: string, end: string) => Math.max(((time(end) - time(start)) / DAY_MS + 1) / days * 100, 0.4);
  const shown = (text: string) => ({ onMouseEnter: () => setDetail(text), onFocus: () => setDetail(text), onClick: () => setDetail(text), title: text });
  // Transactions by day, every source on it.
  const byDay = new Map<string, { source: CoverageSource; count: number }[]>();
  for (const day of coverage.transactions) byDay.set(day.date, [...(byDay.get(day.date) ?? []), { source: day.source, count: day.count }]);
  const sources = [...new Set([...coverage.balances.map((run) => run.source), ...coverage.transactions.map((day) => day.source)])];
  const filled = coverage.balances.some((run) => run.filled);
  const rowLabel = 'w-24 shrink-0 text-xs text-muted-foreground';
  return (
    <div className="grid gap-1.5" onMouseLeave={() => setDetail(null)}>
      <div className="flex items-center gap-2">
        <span className={rowLabel}>Balances</span>
        <div className="relative h-4 flex-1 overflow-hidden rounded-sm bg-muted/60">
          {coverage.balances.map((run) => {
            const color = SOURCE_COLORS[run.source];
            const text = `Balances · ${SOURCE_LABELS[run.source]}${run.filled ? ', filled in by Wattle' : ''} · ${longDate(run.from)} – ${longDate(run.to)}`;
            return (
              <span
                key={`${run.from}:${run.source}:${run.filled}`}
                tabIndex={0}
                className="absolute inset-y-0 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                style={{ left: `${left(run.from)}%`, width: `${width(run.from, run.to)}%`, background: run.filled ? `repeating-linear-gradient(135deg, ${color} 0 2px, transparent 2px 5px)` : color }}
                {...shown(text)}
              />
            );
          })}
          {coverage.unchangedSince && (
            <span
              tabIndex={0}
              className="absolute inset-y-0 border-2 border-dashed border-negative outline-none"
              style={{ left: `${left(coverage.unchangedSince)}%`, width: `${width(coverage.unchangedSince, to)}%` }}
              {...shown(`The institution's balance hasn't changed since ${longDate(coverage.unchangedSince)}, though there are transactions after: it has stopped updating.`)}
            />
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className={rowLabel}>Transactions</span>
        <div className="relative h-4 flex-1 overflow-hidden rounded-sm bg-muted/60">
          {[...byDay].map(([date, found]) => {
            const total = found.reduce((sum, item) => sum + item.count, 0);
            const text = `${longDate(date)} · ${total} ${total === 1 ? 'transaction' : 'transactions'} · ${found.map((item) => SOURCE_LABELS[item.source]).join(', ')}`;
            return <span key={date} className="absolute inset-y-0 w-px min-w-[2px]" style={{ left: `${left(date)}%`, background: SOURCE_COLORS[found[0].source] }} {...shown(text)} />;
          })}
        </div>
      </div>
      <div className="flex items-start gap-2">
        <span className={rowLabel} />
        <div className="relative h-4 flex-1 text-[11px] text-muted-foreground">
          {axisMarks(from, to).map((mark) => (
            // Centred on its day, kept inside at the ends.
            <span key={mark.date} className="absolute whitespace-nowrap" style={{ left: `${left(mark.date)}%`, transform: `translateX(${left(mark.date) > 88 ? -100 : left(mark.date) < 8 ? 0 : -50}%)` }}>
              {mark.label}
            </span>
          ))}
        </div>
      </div>
      <p className="min-h-4 text-xs text-muted-foreground" aria-live="polite">
        {detail ?? (
          <span className="flex flex-wrap gap-x-3 gap-y-1">
            {sources.map((source) => (
              <span key={source} className="inline-flex items-center gap-1">
                <span className="inline-block size-2.5 rounded-sm" style={{ background: SOURCE_COLORS[source] }} />
                {SOURCE_LABELS[source]}
              </span>
            ))}
            {filled && (
              <span className="inline-flex items-center gap-1">
                <span className="inline-block size-2.5 rounded-sm" style={{ background: 'repeating-linear-gradient(135deg, var(--series-neutral) 0 2px, transparent 2px 4px)' }} />
                Filled in by Wattle
              </span>
            )}
            {coverage.unchangedSince && (
              <span className="inline-flex items-center gap-1">
                <span className="inline-block size-2.5 rounded-sm border border-dashed border-negative" />
                Balance not updating
              </span>
            )}
          </span>
        )}
      </p>
    </div>
  );
}
