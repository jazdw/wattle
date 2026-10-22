import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { ActivityEntry, ActivityResponse, SyncRunSummary } from '../../shared/types';
import { renderPage } from '../test/render';
import { sent, server } from '../test/server';
import { Activity } from './Activity';

const at = (iso: string) => Date.parse(iso);
const run = (id: string, startedAt: number, extra: Partial<SyncRunSummary> = {}): ActivityEntry => ({
  kind: 'run',
  startedAt,
  connectionId: 'c-chase',
  institutionName: 'Chase',
  run: { id, action: 'sync', trigger: 'nightly', startedAt, finishedAt: startedAt, outcome: 'ok', errorCode: null, errorMessage: null, note: null, plaidCalls: [], counts: {}, changes: [], truncated: false, ...extra },
});

const FIRST: ActivityResponse = {
  entries: [
    { kind: 'nightly', id: 'j2', startedAt: at('2026-10-09T02:00:00Z'), finishedAt: at('2026-10-09T02:00:12Z'), date: '2026-10-08', state: 'interrupted' },
    run('r2', at('2026-10-09T02:00:01Z') - 1, { action: 'history', outcome: 'error', errorCode: 'INTERRUPTED', errorMessage: 'Stopped before finishing.' }),
    {
      kind: 'job',
      id: 'j-failed',
      startedAt: at('2026-10-09T01:00:00Z'),
      type: 'history_block',
      connectionId: 'c-chase',
      institutionName: 'Chase',
      attempts: 3,
      errorCode: null,
      errorMessage: 'Tiingo said no.',
    },
    {
      kind: 'snapshot',
      id: 's1',
      startedAt: at('2026-10-08T02:00:05Z'),
      finishedAt: at('2026-10-08T02:00:06Z'),
      date: '2026-10-07',
      trigger: 'nightly',
      outcome: 'ok',
      errorCode: null,
      errorMessage: null,
      accounts: 4,
      holdings: 12,
    },
  ],
  next: { startedAt: at('2026-10-08T02:00:05Z'), kind: 'snapshot', id: 's1' },
};
const OLDER: ActivityResponse = { entries: [run('r1', at('2026-10-07T02:00:00Z'))], next: null };

function serve() {
  server.use(http.get('*/api/activity', ({ request }) => HttpResponse.json(new URL(request.url).searchParams.has('after') ? OLDER : FIRST)));
}

describe('Activity page', () => {
  it("shows the household's runs, snapshots and nightly updates by day, and loads older ones", async () => {
    serve();
    const { user } = renderPage(<Activity />);
    expect(await screen.findByText('Nightly update')).toBeInTheDocument();
    expect(screen.getAllByText('Stopped part-way')).toHaveLength(2); // the nightly update and the history load
    expect(screen.getByText('Chase · History load')).toBeInTheDocument();
    expect(screen.getByText('4 accounts · 12 holdings')).toBeInTheDocument();
    expect(screen.getByText(/Snapshot of/)).toBeInTheDocument();
    expect(screen.getByText('Chase · Loading history')).toBeInTheDocument();
    expect(screen.getByText('Failed after 3 attempts')).toBeInTheDocument();
    expect(screen.getByText('Tiingo said no.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Load older' }));
    expect(await screen.findByText('Chase · Sync')).toBeInTheDocument();
    expect(sent('GET /api/activity')[1].url.searchParams.get('after')).toBe(JSON.stringify(FIRST.next));
    expect(screen.queryByRole('button', { name: 'Load older' })).not.toBeInTheDocument();
  });

  it('filters by kind, and to problems only', async () => {
    serve();
    const { user } = renderPage(<Activity />);
    await screen.findByText('Nightly update');
    await user.click(screen.getByRole('tab', { name: 'Snapshots' }));
    expect(screen.queryByText('Nightly update')).not.toBeInTheDocument();
    expect(screen.getByText(/Snapshot of/)).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'All' }));
    await user.click(screen.getByRole('switch'));
    const list = screen.getByText('Nightly update').closest('div.grid') as HTMLElement;
    expect(within(list).queryByText(/Snapshot of/)).not.toBeInTheDocument();
    expect(within(list).getByText('Chase · History load')).toBeInTheDocument();
    expect(within(list).getByText('Chase · Loading history')).toBeInTheDocument();

    await user.click(screen.getByRole('switch'));
    await user.click(screen.getByRole('tab', { name: 'Failed jobs' }));
    expect(screen.getByText('Chase · Loading history')).toBeInTheDocument();
    expect(screen.queryByText('Nightly update')).not.toBeInTheDocument();
  });
});
