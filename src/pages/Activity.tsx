import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { ActivityEntry, ActivityResponse } from '../../shared/types';
import { api } from '../api';
import { PageHeader } from '../components/Layout';
import { RunEntry } from '../components/RunEntry';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Alert, EmptyState, Skeleton } from '../components/ui/misc';
import { Segmented } from '../components/ui/segmented';
import { Switch } from '../components/ui/switch';
import { dateTime, shortDate } from '../lib/format';

type Show = 'all' | 'run' | 'snapshot' | 'nightly';

const SHOW_OPTIONS: { value: Show; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'run', label: 'Logins' },
  { value: 'snapshot', label: 'Snapshots' },
  { value: 'nightly', label: 'Nightly' },
];

function hasProblem(entry: ActivityEntry): boolean {
  if (entry.kind === 'run') return entry.run.outcome === 'error';
  if (entry.kind === 'snapshot') return entry.outcome === 'error';
  return entry.state === 'interrupted';
}

function day(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function SnapshotEntry({ entry }: { entry: Extract<ActivityEntry, { kind: 'snapshot' }> }) {
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-3 py-2 text-sm">
      <span className="font-medium">Snapshot of {shortDate(entry.date)}</span>
      <span className="text-muted-foreground">({entry.trigger === 'nightly' ? 'nightly' : 'after a change'})</span>
      {entry.outcome === 'error' && <Badge variant="danger">{entry.errorCode === 'INTERRUPTED' ? 'Stopped part-way' : 'Failed'}</Badge>}
      {entry.outcome === 'running' && <Badge variant="outline">Running</Badge>}
      {entry.outcome === 'ok' && (
        <span className="text-muted-foreground">
          {entry.accounts} accounts · {entry.holdings} holdings
        </span>
      )}
      <span className="ml-auto text-xs text-muted-foreground">{dateTime(entry.startedAt)}</span>
      {entry.errorMessage && <p className="w-full text-xs text-negative">{entry.errorMessage}</p>}
    </li>
  );
}

function NightlyEntry({ entry }: { entry: Extract<ActivityEntry, { kind: 'nightly' }> }) {
  const seconds = Math.max(0, Math.round((entry.finishedAt - entry.startedAt) / 1000));
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border bg-muted/40 px-3 py-2 text-sm">
      <span className="font-medium">Nightly update</span>
      {entry.state === 'finished' && <span className="text-muted-foreground">finished in {seconds} s</span>}
      {entry.state === 'running' && <Badge variant="outline">Running</Badge>}
      {entry.state === 'interrupted' && <Badge variant="danger">Stopped part-way</Badge>}
      <span className="ml-auto text-xs text-muted-foreground">{dateTime(entry.startedAt)}</span>
    </li>
  );
}

function Entry({ entry }: { entry: ActivityEntry }) {
  if (entry.kind === 'run') return <RunEntry run={entry.run} title={entry.institutionName} />;
  if (entry.kind === 'snapshot') return <SnapshotEntry entry={entry} />;
  return <NightlyEntry entry={entry} />;
}

/** Everything the household's background work did: logins' syncs and history, snapshots, the nightly job. */
export function Activity() {
  const [show, setShow] = useState<Show>('all');
  const [problemsOnly, setProblemsOnly] = useState(false);
  const activity = useInfiniteQuery({
    queryKey: ['household-activity'],
    queryFn: ({ pageParam }) => api<ActivityResponse>(`/api/activity${pageParam ? `?after=${encodeURIComponent(JSON.stringify(pageParam))}` : ''}`),
    initialPageParam: null as ActivityResponse['next'],
    getNextPageParam: (page) => page.next,
  });

  const entries = (activity.data?.pages.flatMap((page) => page.entries) ?? []).filter(
    (entry) => (show === 'all' || entry.kind === show) && (!problemsOnly || hasProblem(entry)),
  );
  const days: { label: string; entries: ActivityEntry[] }[] = [];
  for (const entry of entries) {
    const label = day(entry.startedAt);
    if (days.at(-1)?.label !== label) days.push({ label, entries: [] });
    days.at(-1)!.entries.push(entry);
  }

  return (
    <>
      <PageHeader title="Activity" description="Every sync, history load, snapshot and nightly update over the last two years, newest first." />
      <div className="mb-4 flex flex-wrap items-center gap-4">
        <Segmented value={show} options={SHOW_OPTIONS} onChange={setShow} />
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={problemsOnly} onCheckedChange={setProblemsOnly} />
          Problems only
        </label>
      </div>
      {activity.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : activity.isError ? (
        <Alert variant="error">{activity.error.message}</Alert>
      ) : days.length === 0 ? (
        <EmptyState title={problemsOnly ? 'No problems' : 'Nothing logged yet'}>
          {activity.hasNextPage ? 'Nothing in this page; load more to look further back.' : null}
        </EmptyState>
      ) : (
        <div className="grid gap-5">
          {days.map(({ label, entries: dayEntries }) => (
            <section key={label}>
              <h2 className="mb-2 text-sm font-medium text-muted-foreground">{label}</h2>
              <ul className="grid gap-2">
                {dayEntries.map((entry) => (
                  <Entry key={`${entry.kind}:${entry.kind === 'run' ? entry.run.id : entry.id}`} entry={entry} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {activity.hasNextPage && (
        <Button variant="outline" className="mt-4" onClick={() => void activity.fetchNextPage()} disabled={activity.isFetchingNextPage}>
          {activity.isFetchingNextPage ? 'Loading…' : 'Load older'}
        </Button>
      )}
    </>
  );
}
