/**
 * An account's history at a glance: its balances as a bar coloured by where
 * each run of days came from (your files, the institution, you; hatched where
 * Wattle filled them, empty where there are none), and its transactions the
 * same way: the days each source covers, coloured by the one whose
 * transactions count there (empty where none does). Pointed at, a cursor
 * marks the day with what each has on it, as the growth chart's does. Plain
 * data in, so the Accounts page shows what's stored and the import page can
 * add a file's days (`new`) beside it.
 */
import { useState, type KeyboardEvent, type PointerEvent } from 'react';
import { addDays, type IsoDate } from '../../shared/dates';
import type { AccountCoverage } from '../../shared/types';
import { historySpan, SOURCE_COLORS, SOURCE_LABELS, transactionRuns, type TransactionRun } from '../lib/coverage';
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

/** Where the cursor is: a day, and how it got there (a mouse leaving clears it; a tap or a key keeps it). */
type Cursor = { date: IsoDate; pointer: string };

export function HistoryTimeline({ coverage, today }: { coverage: Pick<AccountCoverage, 'balances' | 'transactions' | 'unchangedSince'>; today: IsoDate }) {
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const span = historySpan(coverage);
  if (!span) return <p className="text-xs text-muted-foreground">No history stored yet.</p>;
  const from = span.from;
  const to = span.to > today ? span.to : today;
  const days = (time(to) - time(from)) / DAY_MS + 1;
  const left = (date: string) => ((time(date) - time(from)) / DAY_MS / days) * 100;
  const width = (start: string, end: string) => Math.max(((time(end) - time(start)) / DAY_MS + 1) / days * 100, 0.4);
  const runs = transactionRuns(coverage.transactions);
  const sources = [...new Set([...coverage.balances.map((run) => run.source), ...runs.map((run) => run.source)])];
  const filled = coverage.balances.some((run) => run.filled);
  const clamp = (date: IsoDate) => (date < from ? from : date > to ? to : date);
  // The day under the pointer: the bars' width is every day, evenly.
  const pointAt = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return;
    const index = Math.floor(((event.clientX - box.left) / box.width) * days);
    setCursor({ date: clamp(addDays(from, Math.min(Math.max(index, 0), days - 1))), pointer: event.pointerType });
  };
  // Arrows a day, with Shift a month; Home and End the first and last.
  const keyed = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = cursor?.date ?? to;
    const step = event.shiftKey ? 30 : 1;
    const next = event.key === 'ArrowLeft' ? addDays(at, -step) : event.key === 'ArrowRight' ? addDays(at, step) : event.key === 'Home' ? from : event.key === 'End' ? to : null;
    if (!next) return;
    event.preventDefault();
    setCursor({ date: clamp(next), pointer: 'keyboard' });
  };
  const rowLabel = 'h-4 text-xs leading-4 text-muted-foreground';
  const at = cursor && left(cursor.date) + 50 / days;
  return (
    <div className="flex gap-2">
      <div className="grid w-24 shrink-0 content-start gap-1.5">
        <span className={rowLabel}>Balances</span>
        <span className={rowLabel}>Transactions</span>
      </div>
      <div className="relative grid min-w-0 flex-1 gap-1.5">
        <div
          role="group"
          aria-label="History by day: use the arrow keys to move through it"
          tabIndex={0}
          className="relative grid touch-pan-y gap-1.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onPointerMove={pointAt}
          onPointerDown={pointAt}
          onPointerLeave={(event) => event.pointerType === 'mouse' && setCursor(null)}
          onKeyDown={keyed}
          onFocus={() => setCursor((now) => now ?? { date: to, pointer: 'keyboard' })}
          onBlur={() => setCursor((now) => (now?.pointer === 'keyboard' ? null : now))}
        >
          <div className="relative h-4 overflow-hidden rounded-sm bg-muted/60">
            {coverage.balances.map((run) => {
              const color = SOURCE_COLORS[run.source];
              return (
                <span
                  key={`${run.from}:${run.source}:${run.filled}`}
                  className="absolute inset-y-0"
                  style={{ left: `${left(run.from)}%`, width: `${width(run.from, run.to)}%`, background: run.filled ? `repeating-linear-gradient(135deg, ${color} 0 2px, transparent 2px 5px)` : color }}
                />
              );
            })}
            {coverage.unchangedSince && (
              <span className="absolute inset-y-0 border-2 border-dashed border-negative" style={{ left: `${left(coverage.unchangedSince)}%`, width: `${width(coverage.unchangedSince, to)}%` }} />
            )}
          </div>
          <div className="relative h-4 overflow-hidden rounded-sm bg-muted/60">
            {runs.map((run) => (
              <span key={`${run.from}:${run.source}`} className="absolute inset-y-0" style={{ left: `${left(run.from)}%`, width: `${width(run.from, run.to)}%`, background: SOURCE_COLORS[run.source] }} />
            ))}
          </div>
          {at !== null && <span className="pointer-events-none absolute -inset-y-0.5 w-px bg-foreground" style={{ left: `${at}%` }} />}
        </div>
        {cursor && <DayCard date={cursor.date} at={at!} coverage={coverage} runs={runs} />}
        <div className="relative h-4 text-[11px] text-muted-foreground">
          {/* Its first and last day always; months or years between, clear of them, where there's room. */}
          <span className="absolute left-0 whitespace-nowrap">{longDate(from)}</span>
          <span className="absolute right-0 whitespace-nowrap">{longDate(to)}</span>
          {axisMarks(from, to)
            .filter((mark) => left(mark.date) > 20 && left(mark.date) < 80)
            .map((mark) => (
              <span key={mark.date} className="absolute hidden -translate-x-1/2 whitespace-nowrap sm:inline" style={{ left: `${left(mark.date)}%` }}>
                {mark.label}
              </span>
            ))}
        </div>
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
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
        </p>
      </div>
    </div>
  );
}

/** What the timeline has on the cursor's day, beside it like the growth chart's: its balance's source and the transactions' run it's in. */
function DayCard({ date, at, coverage, runs }: { date: IsoDate; at: number; coverage: Pick<AccountCoverage, 'balances' | 'unchangedSince'>; runs: TransactionRun[] }) {
  const balance = coverage.balances.find((run) => run.from <= date && run.to >= date);
  const run = runs.find((found) => found.from <= date && found.to >= date);
  const stale = coverage.unchangedSince && date >= coverage.unchangedSince ? coverage.unchangedSince : null;
  const swatch = (color: string, hatched = false) => (
    <span className="mt-0.5 inline-block size-2 shrink-0 rounded-sm" style={{ background: hatched ? `repeating-linear-gradient(135deg, ${color} 0 2px, transparent 2px 4px)` : color }} />
  );
  return (
    <div
      role="status"
      // Beside the cursor, on whichever side has more room.
      className="pointer-events-none absolute top-11 z-10 w-max max-w-[min(18rem,100%)] rounded-md border bg-card px-3 py-2 text-xs shadow-md"
      style={at < 50 ? { left: `calc(${at}% + 0.5rem)` } : { right: `calc(${100 - at}% + 0.5rem)` }}
    >
      <p className="mb-1 font-medium">{longDate(date)}</p>
      <p className="flex gap-1.5">
        {balance ? swatch(SOURCE_COLORS[balance.source], balance.filled) : swatch('var(--color-muted)')}
        <span>
          <span className="text-muted-foreground">Balance </span>
          {balance ? `${SOURCE_LABELS[balance.source]}${balance.filled ? ', filled in by Wattle' : ''}` : 'None'}
          {stale && <span className="block text-negative">Not updating since {longDate(stale)}</span>}
        </span>
      </p>
      <p className="flex gap-1.5">
        {run ? swatch(SOURCE_COLORS[run.source]) : swatch('var(--color-muted)')}
        <span>
          <span className="text-muted-foreground">Transactions </span>
          {run ? SOURCE_LABELS[run.source] : 'None recorded'}
          {run && (
            <span className="block text-muted-foreground">
              {longDate(run.from)} – {longDate(run.to)}
            </span>
          )}
          {run && run.count !== null && <span className="block text-muted-foreground">{`${run.count} ${run.count === 1 ? 'transaction' : 'transactions'}`}</span>}
        </span>
      </p>
    </div>
  );
}
