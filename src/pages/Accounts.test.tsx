import { act, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { account, CONNECTIONS } from '../test/fixtures';
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

    // Cancelling leaves it connected.
    await user.click(within(chase).getByRole('button', { name: 'Disconnect' }));
    let dialog = await screen.findByRole('dialog', { name: 'Disconnect Chase?' });
    expect(within(dialog).getByText(/kept as manual accounts/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(sent('DELETE /api/connections/c-chase')).toHaveLength(0);

    await user.click(within(chase).getByRole('button', { name: 'Disconnect' }));
    dialog = await screen.findByRole('dialog', { name: 'Disconnect Chase?' });
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await expect.poll(() => sent('DELETE /api/connections/c-chase').length).toBe(1);
    await expect.poll(() => screen.queryByRole('dialog')).toBeNull();
  });

  it('links a new institution through Plaid Link', async () => {
    server.use(http.post('*/api/plaid/link-token', () => HttpResponse.json({ linkToken: 'link-sandbox-abc' })));
    const { user } = renderPage(<Accounts />);
    await user.click(await screen.findByRole('button', { name: 'Link account' }));
    await expect.poll(() => plaidLink.open.mock.calls.length).toBe(1);
    expect(plaidLink.token).toBe('link-sandbox-abc');
    expect(sent('POST /api/plaid/link-token')[0].body).toEqual({ kind: 'account' });

    plaidLink.onSuccess!('public-sandbox-xyz');
    await expect.poll(() => sent('POST /api/plaid/exchange')[0]?.body).toEqual({ publicToken: 'public-sandbox-xyz', kind: 'account' });
    // What each login brings in.
    expect(screen.getByText(/· Balance history ·/)).toBeInTheDocument();
    expect(screen.getByText(/· Holdings ·/)).toBeInTheDocument();
  });

  it('links investments only, for institutions without balance history', async () => {
    const { user } = renderPage(<Accounts />);
    await user.click(await screen.findByRole('button', { name: 'Link investments only' }));
    await expect.poll(() => sent('POST /api/plaid/link-token')[0]?.body).toEqual({ kind: 'investments' });
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

  it("disables the button while Link is open and shows Plaid's exit error", async () => {
    const { user } = renderPage(<Accounts />);
    const button = await screen.findByRole('button', { name: 'Link account' });
    await user.click(button);
    await expect.poll(() => plaidLink.open.mock.calls.length).toBe(1);
    expect(button).toBeDisabled();
    act(() => plaidLink.onExit!({ display_message: 'The institution is unavailable.' }));
    expect(await screen.findByText('The institution is unavailable.')).toBeInTheDocument();
    expect(button).toBeEnabled();
  });

  it("shows a connection's activity log", async () => {
    server.use(
      http.get('*/api/connections/c-chase/activity', () =>
        HttpResponse.json({
          runs: [
            {
              id: 'r3', action: 'sync', trigger: 'webhook', startedAt: Date.now(), finishedAt: Date.now(), outcome: 'skipped',
              errorCode: null, errorMessage: null, note: 'Another sync was running; it will sync again when it finishes.', truncated: false,
              plaidCalls: [], counts: {}, changes: [],
            },
            {
              id: 'r2', action: 'sync', trigger: 'nightly', startedAt: Date.now(), finishedAt: Date.now(), outcome: 'error',
              errorCode: 'ITEM_LOGIN_REQUIRED', errorMessage: 'Plaid ITEM_LOGIN_REQUIRED: sign in again', note: null, truncated: false,
              plaidCalls: [{ endpoint: '/accounts/get', requestId: 'req-failed', error: 'ITEM_LOGIN_REQUIRED' }], counts: {}, changes: [],
            },
            {
              id: 'r1', action: 'sync', trigger: 'manual', startedAt: Date.now() - 60_000, finishedAt: Date.now() - 59_000, outcome: 'ok',
              errorCode: null, errorMessage: null, note: null, truncated: false,
              plaidCalls: [{ endpoint: '/accounts/get', requestId: 'req-abc123' }],
              counts: { accounts: 2 },
              changes: [{ kind: 'balance', accountId: 'a1', account: 'Sapphire', before: -10_000, after: -12_550, currency: 'USD' }],
            },
          ],
        }),
      ),
    );
    const { user } = renderPage(<Accounts />);
    await screen.findByText('Sapphire');
    await user.click(within(card('Chase')).getByRole('button', { name: /Activity/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Activity: Chase' });
    // The failed run's badge, and the failed Plaid request.
    expect(within(dialog).getAllByText('ITEM_LOGIN_REQUIRED')).toHaveLength(2);
    expect(within(dialog).getByText(/req-failed/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Stored: 2 accounts/)).toBeInTheDocument();
    expect(within(dialog).getByText('Sapphire: balance -$100.00 → -$125.50')).toBeInTheDocument();
    expect(within(dialog).getByText(/req-abc123/)).toBeInTheDocument();
    expect(within(dialog).getByText('Nothing to do')).toBeInTheDocument();
    expect(within(dialog).getByText(/it will sync again when it finishes/)).toBeInTheDocument();
  });

  it('flags a likely duplicate, naming the original in the edit dialog', async () => {
    server.use(
      http.get('*/api/accounts', () =>
        HttpResponse.json({
          accounts: [
            account({ id: 'j1', source: 'plaid', connectionId: 'c-chase', institutionName: 'Chase', name: 'Joint Checking', mask: '1234', balance: 500_00, displayBalance: 500_00 }),
            account({ id: 'j2', source: 'plaid', connectionId: 'c-vg', institutionName: 'Chase', name: 'Joint Checking', mask: '1234', balance: 500_00, displayBalance: 500_00, possibleDuplicateOf: 'j1' }),
          ],
        }),
      ),
    );
    const { user } = renderPage(<Accounts />);
    const badge = await screen.findByText('Possible duplicate');
    expect(screen.getAllByText('Possible duplicate')).toHaveLength(1); // only the later copy
    const row = badge.closest('li') as HTMLElement;
    expect(within(row).queryByRole('button', { name: /hide/i })).not.toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Edit account' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Joint Checking at Chase')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('switch'));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await expect.poll(() => (sent('PATCH /api/accounts/j2')[0]?.body as { isHidden?: boolean })?.isHidden).toBe(true);
  });

  it('shows Plaid errors', async () => {
    server.use(http.post('*/api/plaid/link-token', () => HttpResponse.json({ error: 'Plaid is not configured on the server.' }, { status: 503 })));
    const { user } = renderPage(<Accounts />);
    await user.click(await screen.findByRole('button', { name: 'Link account' }));
    expect(await screen.findByText('Plaid is not configured on the server.')).toBeInTheDocument();
  });

  it('hides Plaid buttons and explains when Plaid is not configured', async () => {
    server.use(http.get('*/api/connections', () => HttpResponse.json({ ...CONNECTIONS, plaidEnv: null, connections: [] })));
    renderPage(<Accounts />);
    expect(await screen.findByText(/only manual accounts are available/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Link / })).not.toBeInTheDocument();
  });

  it('counts used Plaid Items in production', async () => {
    server.use(http.get('*/api/connections', () => HttpResponse.json({ ...CONNECTIONS, plaidEnv: 'production', itemsUsed: 7 })));
    renderPage(<Accounts />);
    expect(await screen.findByText(/Plaid Items used: 7 of 10/)).toBeInTheDocument();
  });
});
