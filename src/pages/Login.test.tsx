import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { renderPage } from '../test/render';
import { server } from '../test/server';
import { Login } from './Login';

const signedOut = () => http.get('*/api/auth/me', () => HttpResponse.json({ error: 'unauthenticated' }, { status: 401 }));

describe('Login page', () => {
  it('offers Google sign-in and explains errors', async () => {
    server.use(signedOut());
    renderPage(<Login />, { route: '/login?auth=not_allowed' });
    expect(await screen.findByRole('link', { name: 'Sign in with Google' })).toHaveAttribute('href', '/api/auth/google');
    expect(screen.getByText(/not allowed to use Wattle Wealth/)).toBeInTheDocument();
  });

  it('lists dev accounts in development and signs in with one', async () => {
    server.use(
      signedOut(),
      http.get('*/api/auth/dev-users', () => HttpResponse.json({ users: [{ email: 'demo@example.com', name: 'Demo' }] })),
      http.get('*/api/auth/dev', () => new HttpResponse(null, { status: 200 })),
    );
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign, origin: window.location.origin });
    const { user } = renderPage(<Login />, { route: '/login' });
    await user.click(await screen.findByRole('button', { name: 'Demo' }));
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
  });

  it('reports a failed dev sign-in', async () => {
    server.use(
      signedOut(),
      http.get('*/api/auth/dev-users', () => HttpResponse.json({ users: [{ email: 'demo@example.com', name: 'Demo' }] })),
      http.get('*/api/auth/dev', () => HttpResponse.json({ error: 'nope' }, { status: 403 })),
    );
    const { user } = renderPage(<Login />, { route: '/login' });
    await user.click(await screen.findByRole('button', { name: 'Demo' }));
    expect(await screen.findByText('Dev sign-in failed (403)')).toBeInTheDocument();
  });
});
