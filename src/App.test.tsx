import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import App from './App';
import { CONNECTIONS } from './test/fixtures';
import { renderPage } from './test/render';
import { sent, server } from './test/server';

describe('App shell', () => {
  it('sends signed-out visitors to the login page', async () => {
    server.use(http.get('*/api/auth/me', () => HttpResponse.json({ error: 'unauthenticated' }, { status: 401 })));
    renderPage(<App />, { route: '/allocation' });
    expect(await screen.findByRole('link', { name: 'Sign in with Google' })).toBeInTheDocument();
  });

  it('navigates between pages from the sidebar', async () => {
    const { user } = renderPage(<App />, { route: '/' });
    expect(await screen.findByRole('heading', { name: 'Net worth' })).toBeInTheDocument();
    for (const [link, heading] of [
      ['Growth', 'Growth'],
      ['Allocation', 'Allocation'],
      ['Holdings', 'Holdings'],
      ['Style', 'Style'],
      ['Accounts', 'Accounts'],
      ['Settings', 'Settings'],
    ]) {
      await user.click(screen.getByRole('link', { name: link }));
      expect(await screen.findByRole('heading', { name: heading, level: 1 })).toBeInTheDocument();
    }
  });

  it('flags broken connections in the sidebar and switches currency', async () => {
    const { user } = renderPage(<App />, { route: '/' });
    await screen.findByRole('heading', { name: 'Net worth' });
    // Vanguard needs re-authentication: the Accounts link carries a red dot.
    await expect.poll(() => screen.getByRole('link', { name: 'Accounts' }).querySelector('.bg-negative')).not.toBeNull();

    // The sidebar (desktop); the phone's top bar has the same switch.
    const sidebar = within(screen.getByRole('complementary'));
    await user.click(sidebar.getByRole('tab', { name: 'AUD' }));
    for (const tab of screen.getAllByRole('tab', { name: 'AUD' })) expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(localStorage.getItem('wt-currency')).toBe('AUD');
    await expect.poll(() => sent('GET /api/portfolio').some((request) => request.url.searchParams.get('currency') === 'AUD')).toBe(true);
  });

  it('signs out', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign, origin: window.location.origin });
    const { user } = renderPage(<App />, { route: '/' });
    expect(await screen.findByTitle('Signed in as me@example.com')).toHaveTextContent('Jared W');
    await user.click(within(await screen.findByRole('banner')).getByRole('button', { name: 'Sign out' }));
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/login'));
    expect(sent('POST /api/auth/logout')).toHaveLength(1);
  });

  it('redirects unknown paths home', async () => {
    renderPage(<App />, { route: '/nowhere' });
    expect(await screen.findByRole('heading', { name: 'Net worth' })).toBeInTheDocument();
  });
  it('polls while history loads, backing off, then refreshes the rest of the app', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let polls = 0;
      let done = false;
      server.use(
        http.get('*/api/connections', () => {
          polls += 1;
          const backfillStatus = done ? 'done' : 'running';
          return HttpResponse.json({ ...CONNECTIONS, connections: CONNECTIONS.connections.map((connection) => ({ ...connection, backfillStatus })) });
        }),
      );
      renderPage(<App />, { route: '/accounts' });
      expect(await screen.findAllByText('Loading history…')).not.toHaveLength(0);

      // Every 5 s at first…
      await vi.advanceTimersByTimeAsync(5_000);
      expect(polls).toBe(2);
      // …but an hour of waiting (a missed webhook) is dozens of requests, not 720.
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(polls).toBeLessThan(60);

      done = true;
      const historyFetches = sent('GET /api/history').length + sent('GET /api/accounts').length;
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await vi.waitFor(() => expect(screen.queryByText('Loading history…')).not.toBeInTheDocument());
      await vi.waitFor(() => expect(sent('GET /api/history').length + sent('GET /api/accounts').length).toBeGreaterThan(historyFetches));

      // Nothing left loading: no more polling.
      const settled = polls;
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(polls).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });
});
