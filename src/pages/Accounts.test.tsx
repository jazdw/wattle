import { act, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { account, CONNECTIONS } from '../test/fixtures';
import { plaidLink } from '../test/plaid';
import { renderPage } from '../test/render';
import { sent, server } from '../test/server';
import { Accounts } from './Accounts';

const card = (title: string) => screen.getByText(title, { selector: 'h3' }).closest('div.rounded-lg') as HTMLElement;
const accountRow = (name: string) => screen.getByText(name).closest('li') as HTMLElement;

describe('Accounts page', () => {
  it("shows a history load's progress on its login", async () => {
    server.use(
      http.get('*/api/connections', () =>
        HttpResponse.json({
          ...CONNECTIONS,
          connections: CONNECTIONS.connections.map((connection) =>
            connection.id === 'c-northwind' ? { ...connection, backfillStatus: 'running', historyProgress: { done: 3, total: 10, waitingUntil: null } } : connection,
          ),
        }),
      ),
    );
    renderPage(<Accounts />);
    expect(await screen.findByText('Loading history… 3 of 10')).toBeInTheDocument();
    expect(card('Northwind')).toContainElement(screen.getByText('Loading history… 3 of 10'));
  });

  it('says when a history load waiting for the next day of database writes continues', async () => {
    const at = new Date();
    at.setHours(18, 2, 0, 0);
    server.use(
      http.get('*/api/connections', () =>
        HttpResponse.json({
          ...CONNECTIONS,
          connections: CONNECTIONS.connections.map((connection) =>
            connection.id === 'c-northwind' ? { ...connection, backfillStatus: 'running', historyProgress: { done: 12, total: 48, waitingUntil: at.getTime() } } : connection,
          ),
        }),
      ),
    );
    renderPage(<Accounts />);
    expect(await screen.findByText(/^Loading history… 12 of 48 · continues at 6:02\sPM$/)).toBeInTheDocument();
  });

  it('offers Reload history only for a login whose history failed', async () => {
    const first = renderPage(<Accounts />);
    await screen.findByText('Travel Card');
    expect(screen.queryByRole('button', { name: 'Reload history' })).not.toBeInTheDocument();
    first.unmount();

    server.use(
      http.get('*/api/connections', () =>
        HttpResponse.json({
          ...CONNECTIONS,
          connections: CONNECTIONS.connections.map((connection) => (connection.id === 'c-northwind' ? { ...connection, backfillStatus: 'failed' } : connection)),
        }),
      ),
    );
    const { user } = renderPage(<Accounts />);
    const button = await screen.findByRole('button', { name: 'Reload history' });
    expect(card('Northwind')).toContainElement(button);
    await user.click(button);
    await expect.poll(() => sent('POST /api/connections/c-northwind/backfill').length).toBe(1);
  });

  it('lists connections with status, owner and their accounts', async () => {
    renderPage(<Accounts />);
    await screen.findByText('Travel Card');
    const northwind = card('Northwind');
    expect(within(northwind).getByText('Connected')).toBeInTheDocument();
    expect(within(northwind).getByText(/No history from bank/)).toBeInTheDocument();
    expect(within(northwind).getByText(/Linked by Pat/)).toBeInTheDocument();
    // Balance history only, so Plaid doesn't refresh its balances: the card says so.
    expect(within(northwind).getByText(/Plaid doesn't refresh this login's balances/)).toBeInTheDocument();

    const vanguard = card('Vanguard');
    expect(within(vanguard).getByText('Sign-in needed')).toBeInTheDocument();
    expect(within(vanguard).getByRole('button', { name: 'Fix connection' })).toBeInTheDocument();
    expect(within(vanguard).getByText(/Linked by Sam/)).toBeInTheDocument();
    expect(within(vanguard).queryByText(/Plaid doesn't refresh/)).not.toBeInTheDocument();

    expect(within(accountRow('Joint IRA copy')).getByText(/Hidden — not synced or counted/)).toBeInTheDocument();
    expect(within(accountRow('Old savings')).getByText(/No longer reported/)).toBeInTheDocument();
    expect(screen.getByText('sandbox', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText('user_good')).toBeInTheDocument();

    const manual = card('Manual accounts');
    expect(within(manual).getByText('Example Super')).toBeInTheDocument();
  });

  it('syncs and disconnects a connection (with confirmation)', async () => {
    const { user } = renderPage(<Accounts />);
    await screen.findByText('Travel Card');
    const northwind = card('Northwind');
    await user.click(within(northwind).getByRole('button', { name: /Sync/ }));
    await expect.poll(() => sent('POST /api/connections/c-northwind/sync').length).toBe(1);

    // Cancelling leaves it connected.
    await user.click(within(northwind).getByRole('button', { name: 'Disconnect' }));
    let dialog = await screen.findByRole('dialog', { name: 'Disconnect Northwind?' });
    expect(within(dialog).getByText(/kept as manual accounts/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(sent('DELETE /api/connections/c-northwind')).toHaveLength(0);

    await user.click(within(northwind).getByRole('button', { name: 'Disconnect' }));
    dialog = await screen.findByRole('dialog', { name: 'Disconnect Northwind?' });
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await expect.poll(() => sent('DELETE /api/connections/c-northwind').length).toBe(1);
    await expect.poll(() => screen.queryByRole('dialog')).toBeNull();
  });

  it('lists disconnected logins apart, with their accounts under manual ones, and reconnects', async () => {
    server.use(
      http.get('*/api/connections', () =>
        HttpResponse.json({ ...CONNECTIONS, connections: CONNECTIONS.connections.map((row) => (row.id === 'c-northwind' ? { ...row, status: 'disconnected' } : row)) }),
      ),
      http.get('*/api/accounts', () =>
        HttpResponse.json({ accounts: [account({ id: 'old', name: 'Old Checking', source: 'manual', connectionId: 'c-northwind', institutionName: 'Northwind' })] }),
      ),
    );
    const { user } = renderPage(<Accounts />);
    await screen.findByText('Disconnected', { selector: 'h3' });
    const section = card('Disconnected');
    expect(within(section).getByText('Northwind')).toBeInTheDocument();
    expect(screen.queryByText('Northwind', { selector: 'h3' })).toBeNull(); // no connection card of its own
    expect(within(card('Manual accounts')).getByText('Old Checking')).toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: /Reconnect/ }));
    await expect.poll(() => sent('POST /api/connections/c-northwind/reconnect').length).toBe(1);
  });

  it('links a new institution through Plaid Link', async () => {
    server.use(http.post('*/api/plaid/link-token', () => HttpResponse.json({ linkToken: 'link-sandbox-abc' })));
    const { user } = renderPage(<Accounts />);
    await user.click(await screen.findByRole('button', { name: 'Link account' }));
    // A chooser explains the options; it closes as Plaid Link opens.
    const chooser = await screen.findByRole('dialog', { name: 'Link an account' });
    expect(within(chooser).getByText(/up to two years of history/)).toBeInTheDocument();
    await user.click(within(chooser).getByRole('button', { name: 'Link account' }));
    await expect.poll(() => plaidLink.open.mock.calls.length).toBe(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
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
    await user.click(await screen.findByRole('button', { name: 'Link account' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Link investments only' }));
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

  it('chooses accounts on a working login at any time, highlighted when new ones are available', async () => {
    server.use(
      http.get('*/api/connections', () =>
        HttpResponse.json({
          ...CONNECTIONS,
          connections: CONNECTIONS.connections.map((connection) => (connection.id === 'c-northwind' ? { ...connection, newAccountsAvailable: true } : connection)),
        }),
      ),
      http.post('*/api/plaid/link-token', () => HttpResponse.json({ linkToken: 'link-choose' })),
      http.post('*/api/connections/c-northwind/accounts-chosen', () => HttpResponse.json({ added: 1, historyQueued: true })),
    );
    const { user } = renderPage(<Accounts />);
    await screen.findByText('Travel Card');
    expect(within(card('Northwind')).getByText('New accounts available')).toBeInTheDocument();
    // Only on working logins (Vanguard needs fixing first).
    expect(within(card('Vanguard')).queryByRole('button', { name: 'Choose accounts' })).not.toBeInTheDocument();
    await user.click(within(card('Northwind')).getByRole('button', { name: 'Choose accounts' }));
    await expect.poll(() => plaidLink.open.mock.calls.length).toBe(1);
    expect(sent('POST /api/plaid/link-token')[0].body).toEqual({ kind: 'account', connectionId: 'c-northwind', chooseAccounts: true });
    plaidLink.onSuccess!('public-choose');
    await expect.poll(() => sent('POST /api/connections/c-northwind/accounts-chosen').length).toBe(1);
    expect(sent('POST /api/connections/c-northwind/sync')).toHaveLength(0);
    expect(sent('POST /api/plaid/exchange')).toHaveLength(0);
  });

  it('asks before a bank report for new bank accounts: Load history includes them, Not now loads only investment history', async () => {
    const newAccounts = [
      { id: 'a-card', name: 'Cashback card', bank: true },
      { id: 'a-ira', name: 'Roth IRA', bank: false },
    ];
    server.use(
      http.post('*/api/plaid/link-token', () => HttpResponse.json({ linkToken: 'link-choose' })),
      http.post('*/api/connections/c-northwind/accounts-chosen', () => HttpResponse.json({ added: 2, historyQueued: false, newAccounts })),
    );
    const { user } = renderPage(<Accounts />);
    await screen.findByText('Travel Card');
    const choose = async () => {
      await user.click(within(card('Northwind')).getByRole('button', { name: 'Choose accounts' }));
      await expect.poll(() => plaidLink.onSuccess).toBeTruthy();
      act(() => plaidLink.onSuccess!('public-choose'));
      return screen.findByRole('dialog', { name: 'Load history for the new accounts?' });
    };

    const dialog = await choose();
    expect(within(dialog).getByText('Cashback card')).toBeInTheDocument();
    expect(within(dialog).getByText(/Roth IRA: investment history loads either way/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Load history' }));
    await expect.poll(() => sent('POST /api/connections/c-northwind/new-accounts-history').map((request) => request.body)).toEqual([{ accountIds: ['a-card', 'a-ira'], bankReport: true }]);
    await expect.poll(() => screen.queryByRole('dialog')).toBeNull();

    plaidLink.onSuccess = null;
    await user.click(within(await choose()).getByRole('button', { name: 'Not now' }));
    await expect.poll(() => sent('POST /api/connections/c-northwind/new-accounts-history').at(-1)?.body).toEqual({ accountIds: ['a-ira'], bankReport: false });
    await expect.poll(() => screen.queryByRole('dialog')).toBeNull();
  });

  it("disables the button while Link is open and shows Plaid's exit error", async () => {
    const { user } = renderPage(<Accounts />);
    const button = await screen.findByRole('button', { name: 'Link account' });
    await user.click(button);
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Link account' }));
    await expect.poll(() => plaidLink.open.mock.calls.length).toBe(1);
    expect(button).toBeDisabled();
    act(() => plaidLink.onExit!({ display_message: 'The institution is unavailable.' }));
    expect(await screen.findByText('The institution is unavailable.')).toBeInTheDocument();
    expect(button).toBeEnabled();
  });

  it("shows a connection's activity log", async () => {
    server.use(
      http.get('*/api/connections/c-northwind/activity', () =>
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
              changes: [{ kind: 'balance', accountId: 'a1', account: 'Travel Card', before: -10_000, after: -12_550, currency: 'USD' }],
            },
          ],
        }),
      ),
    );
    const { user } = renderPage(<Accounts />);
    await screen.findByText('Travel Card');
    await user.click(within(card('Northwind')).getByRole('button', { name: /Activity/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Activity: Northwind' });
    // The failed run's badge, and the failed Plaid request.
    expect(within(dialog).getAllByText('ITEM_LOGIN_REQUIRED')).toHaveLength(2);
    expect(within(dialog).getByText(/req-failed/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Stored: 2 accounts/)).toBeInTheDocument();
    expect(within(dialog).getByText('Travel Card: balance -$100.00 → -$125.50')).toBeInTheDocument();
    expect(within(dialog).getByText(/req-abc123/)).toBeInTheDocument();
    expect(within(dialog).getByText('Nothing to do')).toBeInTheDocument();
    expect(within(dialog).getByText(/it will sync again when it finishes/)).toBeInTheDocument();
  });

  it('flags a likely duplicate, naming the original in the edit dialog', async () => {
    server.use(
      http.get('*/api/accounts', () =>
        HttpResponse.json({
          accounts: [
            account({ id: 'j1', source: 'plaid', connectionId: 'c-northwind', institutionName: 'Northwind', name: 'Joint Checking', mask: '1234', balance: 500_00, displayBalance: 500_00 }),
            account({ id: 'j2', source: 'plaid', connectionId: 'c-vg', institutionName: 'Northwind', name: 'Joint Checking', mask: '1234', balance: 500_00, displayBalance: 500_00, possibleDuplicateOf: 'j1' }),
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
    expect(within(dialog).getByText('Joint Checking at Northwind')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('switch'));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await expect.poll(() => (sent('PATCH /api/accounts/j2')[0]?.body as { isHidden?: boolean })?.isHidden).toBe(true);
  });

  it('shows Plaid errors', async () => {
    server.use(http.post('*/api/plaid/link-token', () => HttpResponse.json({ error: 'Plaid is not configured on the server.' }, { status: 503 })));
    const { user } = renderPage(<Accounts />);
    await user.click(await screen.findByRole('button', { name: 'Link account' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Link account' }));
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

  it("says under each account the days it has history for, and shows where each part came from when it's opened", async () => {
    server.use(
      http.get('*/api/coverage', () =>
        HttpResponse.json({
          today: '2026-10-08',
          accounts: [
            {
              accountId: 'chk',
              balances: [
                { from: '2026-01-01', to: '2026-03-31', source: 'files', filled: false },
                // A gap in April.
                { from: '2026-05-01', to: '2026-10-08', source: 'bank', filled: false },
              ],
              transactions: [
                { from: '2026-01-01', to: '2026-03-31', source: 'files', count: 2 },
                // A gap in April; your file covers May, the bank's report its second half too.
                { from: '2026-05-15', to: '2026-05-31', source: 'bank', count: 0 },
                { from: '2026-05-01', to: '2026-05-31', source: 'files', count: 3 },
                { from: '2026-06-01', to: '2026-09-30', source: 'bank', count: 1 },
              ],
              unchangedSince: '2026-09-01',
            },
          ],
        }),
      ),
    );
    const { user } = renderPage(<Accounts />);
    const toggle = await screen.findByRole('button', { name: "Show Northwind Checking's history" });
    expect(toggle).toHaveTextContent('Balances Jan 1, 2026 – today · 1 gap · Transactions Jan 1, 2026 – Sep 30, 2026 · 1 gap · balance unchanged since Sep 1, 2026');
    expect(screen.queryByText('Imported')).not.toBeInTheDocument();
    // Its first and last day, at the ends.
    await user.click(toggle);
    expect(screen.getByText('Jan 1, 2026', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Oct 8, 2026', { selector: 'span' })).toBeInTheDocument();
    await user.click(toggle);
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // The key: where each part came from, and the balance that stopped updating.
    for (const label of ['Imported', 'Plaid', 'Balance not updating']) expect(screen.getByText(label)).toBeInTheDocument();
    // Pointed at, a cursor marks the day and says what's on it. The bars are a pixel a day here (Jan 1 – Oct 8 is 281 days).
    const bars = screen.getByRole('group', { name: /History by day/ });
    vi.spyOn(bars, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 281, top: 0, height: 38, right: 281, bottom: 38, x: 0, y: 0, toJSON: () => ({}) });
    const status = () => within(bars.parentElement!).queryByRole('status');
    const card = async (day: number) => {
      await user.pointer({ target: bars, coords: { clientX: day + 0.5 } });
      return status()?.textContent;
    };
    expect(await card(14)).toBe('Jan 15, 2026Balance ImportedTransactions ImportedJan 1, 2026 – Mar 31, 20262 transactions');
    // April: a gap in both.
    expect(await card(104)).toBe('Apr 15, 2026Balance NoneTransactions None recorded');
    // Transactions as the days each source covers: May's are your file's, where the bank's report covers some days too.
    expect(await card(139)).toBe('May 20, 2026Balance PlaidTransactions ImportedMay 1, 2026 – May 31, 20263 transactions');
    expect(await card(257)).toBe('Sep 15, 2026Balance PlaidNot updating since Sep 1, 2026Transactions PlaidJun 1, 2026 – Sep 30, 20261 transaction');
    // The mouse leaving clears it.
    await user.pointer({ target: document.body });
    expect(status()).not.toBeInTheDocument();
    // From the keyboard: focused, the last day; the arrows and Home move it.
    act(() => bars.focus());
    expect(status()).toHaveTextContent(/^Oct 8, 2026/);
    await user.keyboard('{ArrowLeft}');
    expect(status()).toHaveTextContent(/^Oct 7, 2026/);
    await user.keyboard('{Home}');
    expect(status()).toHaveTextContent(/^Jan 1, 2026/);
  });
});
