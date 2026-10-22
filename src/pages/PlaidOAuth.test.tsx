import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { plaidLink } from '../test/plaid';
import { renderPage } from '../test/render';
import { sent } from '../test/server';
import { PlaidOAuth } from './PlaidOAuth';

const routes = (
  <Routes>
    <Route path="/plaid-oauth" element={<PlaidOAuth />} />
    <Route path="/accounts" element={<p>Accounts page</p>} />
  </Routes>
);

afterEach(() => sessionStorage.clear());

describe('Plaid OAuth redirect page', () => {
  it('finishes the Link session a bank login interrupted, then goes to Accounts', async () => {
    sessionStorage.setItem('wt-plaid-link', JSON.stringify({ linkToken: 'link-sandbox-abc', kind: 'account' }));
    renderPage(<PlaidOAuth />, { route: '/plaid-oauth?oauth_state_id=xyz', routes });
    await expect.poll(() => plaidLink.open.mock.calls.length).toBe(1);
    expect(plaidLink.token).toBe('link-sandbox-abc');
    expect(plaidLink.receivedRedirectUri).toBe(window.location.href);

    act(() => plaidLink.onSuccess!('public-sandbox-xyz'));
    await expect.poll(() => sent('POST /api/plaid/exchange')[0]?.body).toEqual({ publicToken: 'public-sandbox-xyz', kind: 'account' });
    expect(await screen.findByText('Accounts page')).toBeInTheDocument();
    expect(sessionStorage.getItem('wt-plaid-link')).toBeNull();
  });

  it('resyncs instead for a login being fixed (update mode)', async () => {
    sessionStorage.setItem('wt-plaid-link', JSON.stringify({ linkToken: 'link-update', kind: 'investments', connectionId: 'c-vg' }));
    renderPage(<PlaidOAuth />, { route: '/plaid-oauth', routes });
    await expect.poll(() => plaidLink.open.mock.calls.length).toBe(1);
    act(() => plaidLink.onSuccess!('public-update'));
    await expect.poll(() => sent('POST /api/connections/c-vg/sync').length).toBe(1);
    expect(sent('POST /api/plaid/exchange')).toHaveLength(0);
  });

  it("shows Plaid's error, or says the session ended when there isn't one", async () => {
    sessionStorage.setItem('wt-plaid-link', JSON.stringify({ linkToken: 'link-sandbox-abc', kind: 'account' }));
    const { unmount } = renderPage(<PlaidOAuth />, { route: '/plaid-oauth', routes });
    await expect.poll(() => plaidLink.open.mock.calls.length).toBe(1);
    act(() => plaidLink.onExit!({ display_message: 'The bank declined.' }));
    expect(await screen.findByText('The bank declined.')).toBeInTheDocument();
    unmount();

    renderPage(<PlaidOAuth />, { route: '/plaid-oauth', routes });
    expect(await screen.findByText(/This linking session has ended/)).toBeInTheDocument();
    expect(plaidLink.open.mock.calls.length).toBe(1);
  });
});
