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

  it('warns about a stopped nightly update, stopped runs and history that no longer retries', async () => {
    server.use(
      http.get('*/api/status', () =>
        HttpResponse.json({
          nightly: { date: '2026-10-08', state: 'interrupted' },
          interrupted: [
            { connectionId: 'c-chase', institutionName: 'Chase', action: 'sync', startedAt: Date.parse('2026-10-08T02:00:00Z') },
            { connectionId: 'c-vg', institutionName: 'Vanguard', action: 'history', startedAt: Date.parse('2026-10-08T02:01:00Z') },
          ],
          historyStopped: [{ connectionId: 'c-vg', institutionName: 'Vanguard' }],
        }),
      ),
    );
    renderPage(<StatusBanner />);
    expect(await screen.findByText('The nightly update of 2026-10-08 was stopped before it finished.')).toBeInTheDocument();
    expect(screen.getByText(/Chase: a sync was stopped part-way on .*It's retried automatically/)).toBeInTheDocument();
    expect(screen.getByText(/Vanguard: history was stopped part-way several times in a row/)).toBeInTheDocument();
    // Not also listed as one that's retried.
    expect(screen.queryByText(/Vanguard: loading history/)).not.toBeInTheDocument();
  });
});
