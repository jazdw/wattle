import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { CONNECTIONS } from '../test/fixtures';
import { plaidLink } from '../test/plaid';
import { renderPage } from '../test/render';
import { sent, server } from '../test/server';
import { Accounts } from './Accounts';

const card = (title: string) => screen.getByText(title, { selector: 'h3' }).closest('div.rounded-lg') as HTMLElement;
const accountRow = (name: string) => screen.getByText(name).closest('li') as HTMLElement;

describe('Accounts page', () => {
  it('lists connections with status, owner and their accounts', async () => {
    renderPage(<Accounts />);
    await screen.findByText('Sapphire');
    const chase = card('Chase');
    expect(within(chase).getByText('Connected')).toBeInTheDocument();
    expect(within(chase).getByText(/No history from bank/)).toBeInTheDocument();
    expect(within(chase).getByText(/Linked by Jared/)).toBeInTheDocument();

    const vanguard = card('Vanguard');
    expect(within(vanguard).getByText('Sign-in needed')).toBeInTheDocument();
    expect(within(vanguard).getByRole('button', { name: 'Fix connection' })).toBeInTheDocument();
    expect(within(vanguard).getByText(/Linked by Sam/)).toBeInTheDocument();

    expect(within(accountRow('Joint IRA copy')).getByText(/Hidden — not synced or counted/)).toBeInTheDocument();
    expect(within(accountRow('Old savings')).getByText(/No longer reported/)).toBeInTheDocument();
    expect(screen.getByText('sandbox', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText('user_good')).toBeInTheDocument();

    const manual = card('Manual accounts');
    expect(within(manual).getByText('REST Super')).toBeInTheDocument();
  });

  it('syncs and disconnects a connection (with confirmation)', async () => {
    const { user } = renderPage(<Accounts />);
    await screen.findByText('Sapphire');
    const chase = card('Chase');
    await user.click(within(chase).getByRole('button', { name: /Sync/ }));
    await expect.poll(() => sent('POST /api/connections/c-chase/sync').length).toBe(1);

    await user.click(within(chase).getByRole('button', { name: 'Disconnect' }));
    expect(within(chase).getByText(/kept as manual accounts/)).toBeInTheDocument();
    await user.click(within(chase).getByRole('button', { name: 'Confirm disconnect' }));
    await expect.poll(() => sent('DELETE /api/connections/c-chase').length).toBe(1);
  });

  it('links a new institution through Plaid Link', async () => {
    server.use(http.post('*/api/plaid/link-token', () => HttpResponse.json({ linkToken: 'link-sandbox-abc' })));
    const { user } = renderPage(<Accounts />);
    await user.click(await screen.findByRole('button', { name: 'Link investments' }));
    await expect.poll(() => plaidLink.open.mock.calls.length).toBe(1);
    expect(plaidLink.token).toBe('link-sandbox-abc');
    expect(sent('POST /api/plaid/link-token')[0].body).toEqual({ kind: 'investments' });

    plaidLink.onSuccess!('public-sandbox-xyz');
    await expect.poll(() => sent('POST /api/plaid/exchange')[0]?.body).toEqual({ publicToken: 'public-sandbox-xyz', kind: 'investments' });
  });

  it('re-authenticates a broken connection in update mode', async () => {
    server.use(http.post('*/api/plaid/link-token', () => HttpResponse.json({ linkToken: 'link-update' })));
    const { user } = renderPage(<Accounts />);
    await user.click(await screen.findByRole('button', { name: 'Fix connection' }));
    await expect.poll(() => plaidLink.open.mock.calls.length).toBe(1);
    expect(sent('POST /api/plaid/link-token')[0].body).toEqual({ kind: 'investments', connectionId: 'c-vg' });
    plaidLink.onSuccess!('public-update');
    // Update mode keeps the same token: it resyncs instead of exchanging.
    await expect.poll(() => sent('POST /api/connections/c-vg/sync').length).toBe(1);
    expect(sent('POST /api/plaid/exchange')).toHaveLength(0);
  });

  it('shows Plaid errors', async () => {
    server.use(http.post('*/api/plaid/link-token', () => HttpResponse.json({ error: 'Plaid is not configured on the server.' }, { status: 503 })));
    const { user } = renderPage(<Accounts />);
    await user.click(await screen.findByRole('button', { name: 'Link bank / card' }));
    expect(await screen.findByText('Plaid is not configured on the server.')).toBeInTheDocument();
  });

  it('hides Plaid buttons and explains when Plaid is not configured', async () => {
    server.use(http.get('*/api/connections', () => HttpResponse.json({ ...CONNECTIONS, plaidEnv: null, connections: [] })));
    renderPage(<Accounts />);
    expect(await screen.findByText(/only manual accounts are available/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link investments' })).not.toBeInTheDocument();
  });

  it('counts used Plaid Items in production', async () => {
    server.use(http.get('*/api/connections', () => HttpResponse.json({ ...CONNECTIONS, plaidEnv: 'production', itemsUsed: 7 })));
    renderPage(<Accounts />);
    expect(await screen.findByText(/Plaid Items used: 7 of 10/)).toBeInTheDocument();
  });
});
