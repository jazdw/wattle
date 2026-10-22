import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { renderPage } from '../test/render';
import { server } from '../test/server';
import { StatusBanner } from './StatusBanner';

describe('StatusBanner', () => {
  it('shows nothing when everything finished', async () => {
    const { container } = renderPage(<StatusBanner />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container).toBeEmptyDOMElement();
  });

  it('warns about a stopped nightly update, stopped runs and background jobs that failed', async () => {
    server.use(
      http.get('*/api/status', () =>
        HttpResponse.json({
          nightly: { date: '2026-10-08', state: 'interrupted' },
          interrupted: [{ connectionId: 'c-chase', institutionName: 'Chase', action: 'sync', startedAt: Date.parse('2026-10-08T02:00:00Z') }],
          failedJobs: [
            // A load's parts fail together: one message.
            { type: 'history_block', connectionId: 'c-vg', institutionName: 'Vanguard', finishedAt: Date.parse('2026-10-08T02:05:00Z'), errorCode: 'INTERRUPTED', attempts: 4 },
            { type: 'history_finish', connectionId: 'c-vg', institutionName: 'Vanguard', finishedAt: Date.parse('2026-10-08T02:06:00Z'), errorCode: null, attempts: 3 },
            { type: 'snapshot', connectionId: null, institutionName: null, finishedAt: Date.parse('2026-10-08T02:07:00Z'), errorCode: null, attempts: 3 },
          ],
        }),
      ),
    );
    renderPage(<StatusBanner />);
    expect(await screen.findByText('The nightly update of 2026-10-08 was stopped before it finished.')).toBeInTheDocument();
    expect(screen.getByText(/Chase: a sync was stopped part-way on .*It's retried automatically/)).toBeInTheDocument();
    expect(screen.getAllByText(/^Vanguard: loading history/)).toHaveLength(1);
    expect(screen.getByText(/Vanguard: loading history was stopped part-way every time it ran .*Reload history/)).toBeInTheDocument();
    expect(screen.getByText(/^updating the day's snapshot failed after 3 attempts/)).toBeInTheDocument();
  });
});
