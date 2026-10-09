import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import App from './App';
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

    await user.click(screen.getByRole('tab', { name: 'AUD' }));
    expect(screen.getByRole('tab', { name: 'AUD' })).toHaveAttribute('aria-selected', 'true');
    expect(localStorage.getItem('wt-currency')).toBe('AUD');
    await expect.poll(() => sent('GET /api/portfolio').some((request) => request.url.searchParams.get('currency') === 'AUD')).toBe(true);
  });

  it('signs out', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign, origin: window.location.origin });
    const { user } = renderPage(<App />, { route: '/' });
    await user.click(await screen.findByRole('button', { name: /Sign out/ }));
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/login'));
    expect(sent('POST /api/auth/logout')).toHaveLength(1);
  });

  it('redirects unknown paths home', async () => {
    renderPage(<App />, { route: '/nowhere' });
    expect(await screen.findByRole('heading', { name: 'Net worth' })).toBeInTheDocument();
  });
});
