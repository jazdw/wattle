import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { TransactionEntry, TransactionsResponse, TransfersResponse } from '../../shared/types';
import { renderPage } from '../test/render';
import { sent, server } from '../test/server';
import { Transactions } from './Transactions';

const entry = (id: string, date: string, extra: Partial<TransactionEntry>): TransactionEntry => ({
  id,
  accountId: 'brk',
  currency: 'USD',
  date,
  source: 'plaid',
  type: null,
  subtype: null,
  kind: null,
  kindByYou: false,
  automatic: null,
  transfer: null,
  description: null,
  ticker: null,
  security: null,
  quantity: null,
  price: null,
  amount: 0,
  ...extra,
});

const BROKERAGE: TransactionsResponse = {
  kind: 'investment',
  currency: 'USD',
  from: '2026-06-02',
  to: '2026-09-01',
  matched: 2,
  truncated: false,
  transactions: [
    entry('t2', '2026-09-01', { type: 'buy', subtype: 'buy', kind: 'buy', automatic: 'buy', ticker: 'VXUS', description: 'Buy', quantity: 100, price: 60.25, amount: 6025_00 }),
    entry('t1', '2026-09-01', { type: 'cash', subtype: 'contribution', kind: 'deposit', automatic: 'deposit', ticker: 'CUR:USD', description: 'Funds Received', amount: -10000_00 }),
  ],
};

const CHECKING: TransactionsResponse = {
  kind: 'bank',
  currency: 'USD',
  from: '2026-10-01',
  to: '2026-10-01',
  matched: 1,
  truncated: false,
  transactions: [entry('b1', '2026-10-01', { source: 'report', kind: 'income', automatic: 'income', description: 'Interest', amount: -12_34 })],
};

describe('Transactions', () => {
  it("shows an account's transactions, what each one does, and money in as positive", async () => {
    server.use(
      http.get('*/api/accounts/brk/transactions', () => HttpResponse.json(BROKERAGE)),
      http.get('*/api/accounts/chk/transactions', () => HttpResponse.json(CHECKING)),
    );
    renderPage(<Transactions />, { route: '/?account=brk' });
    expect(await screen.findByText('Funds Received')).toBeInTheDocument();
    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0]).getByLabelText(/^Type of Buy/)).toHaveDisplayValue('Automatic: Purchase');
    expect(rows[0]).toHaveTextContent('-$6,025.00');
    // Plaid's own word for it, under the kind.
    expect(within(rows[1]).getByLabelText(/^Type of Funds Received/)).toHaveDisplayValue('Automatic: Money in');
    expect(rows[1]).toHaveTextContent('Contribution');
    expect(rows[1]).toHaveTextContent('$10,000.00');

    // A bank account: its report's transactions.
    await userEvent.selectOptions(screen.getByLabelText('Account'), 'chk');
    expect(await screen.findByText('Interest')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Type of Interest/)).toHaveDisplayValue('Automatic: Dividend or interest');
  });

  it('sets a type you choose, and back to automatic', async () => {
    server.use(
      http.get('*/api/accounts/brk/transactions', () => HttpResponse.json(BROKERAGE)),
      http.patch('*/api/transactions/:id', () => HttpResponse.json({ ok: true })),
    );
    renderPage(<Transactions />, { route: '/?account=brk' });
    const select = await screen.findByLabelText(/^Type of Funds Received/);
    await userEvent.selectOptions(select, 'Fee');
    await expect.poll(() => sent('PATCH /api/transactions/t1')[0]?.body).toEqual({ kind: 'fee' });
    await userEvent.selectOptions(select, 'Automatic: Money in');
    await expect.poll(() => sent('PATCH /api/transactions/t1')[1]?.body).toEqual({ kind: null });
  });

  it('asks about transfers it could pair more than one way, and links, unlinks and links by hand', async () => {
    const side = (transactionId: string, accountName: string, date: string, amount: number) => ({ transactionId, accountId: accountName.toLowerCase(), accountName, institutionName: null, mask: '1234', date, amount, currency: 'USD' as const, description: null });
    const suggested: TransfersResponse = { transfers: [{ id: 'x1', status: 'suggested', out: { ...side('o1', 'Checking', '2026-09-02', 500_00), description: 'Online transfer 123456789' }, in: side('i1', 'Savings', '2026-09-01', -500_00) }] };
    const linked = { ...BROKERAGE, transactions: [{ ...BROKERAGE.transactions[1], transfer: { id: 'x2', status: 'auto' as const, accountId: 'chk', accountName: 'Checking', institutionName: null, mask: '1234', date: '2026-08-31' } }, { ...BROKERAGE.transactions[1], id: 't3', description: 'Second deposit', transfer: null }] };
    server.use(
      http.get('*/api/transfers', () => HttpResponse.json(suggested)),
      http.get('*/api/accounts/brk/transactions', () => HttpResponse.json(linked)),
      http.get('*/api/transactions/t3/candidates', () => HttpResponse.json({ candidates: [side('c1', 'Checking', '2026-09-01', 10000_00)] })),
    );
    renderPage(<Transactions />, { route: '/?account=brk' });
    expect(await screen.findByText('Transfers to check')).toBeInTheDocument();
    // From and to, each with its description to recognise it by.
    const pair = screen.getByRole('row', { name: /\$500\.00/ });
    expect(within(pair).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['$500.00', 'FromChecking ··1234, Sep 2, 2026Online transfer 123456789', 'ToSavings ··1234, Sep 1, 2026', 'It’s a transferNot a transfer']);
    await userEvent.click(screen.getByRole('button', { name: 'It’s a transfer' }));
    await expect.poll(() => sent('PATCH /api/transfers/x1')[0]?.body).toEqual({ status: 'confirmed' });

    // Linked: where the money came from, and a way to unlink it.
    expect(await screen.findByText('From Checking ··1234, Aug 31, 2026')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    await expect.poll(() => sent('PATCH /api/transfers/x2')[0]?.body).toEqual({ status: 'rejected' });

    // Not linked: pick its other side.
    await userEvent.click(screen.getByRole('button', { name: /^Link Second deposit/ }));
    expect(await screen.findByText(/Checking ··1234, Sep 1, 2026/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Link' }));
    await expect.poll(() => sent('POST /api/transfers')[0]?.body).toEqual({ outId: 'c1', inId: 't3' });
  });

  it('asks which one, from a list, when several could pair with the same transaction', async () => {
    const side = (transactionId: string, accountName: string, date: string, amount: number, description: string | null = null) => ({ transactionId, accountId: accountName.toLowerCase(), accountName, institutionName: null, mask: '1234', date, amount, currency: 'USD' as const, description });
    const deposit = side('in1', 'Brokerage', '2026-08-03', -500_00);
    server.use(
      http.get('*/api/transfers', () =>
        HttpResponse.json({
          transfers: [
            { id: 'p1', status: 'suggested', out: side('o1', 'Checking', '2026-08-03', 500_00, 'PPD ID: 1111111111'), in: deposit },
            { id: 'p2', status: 'suggested', out: side('o2', 'Checking', '2026-08-03', 500_00, 'PPD ID: 2222222222'), in: deposit },
          ],
        } satisfies TransfersResponse),
      ),
      http.get('*/api/accounts/brk/transactions', () => HttpResponse.json(BROKERAGE)),
    );
    renderPage(<Transactions />, { route: '/?account=brk' });
    // One row: the deposit they share on the To side, a list of where it could have come from on the From side.
    const which = await screen.findByLabelText(/^Which transaction/);
    const row = screen.getByRole('row', { name: /\$500\.00/ });
    expect(within(row).getAllByRole('cell')[2]).toHaveTextContent('Brokerage ··1234, Aug 3, 2026');
    expect(within(row).getAllByRole('cell')[1]).not.toHaveTextContent('No description');
    expect(within(row).getAllByRole('cell')[1]).toContainElement(which);
    expect(within(which).getAllByRole('option').map((option) => option.textContent)).toEqual(['Checking ··1234, Aug 3, 2026 · PPD ID: 1111111111', 'Checking ··1234, Aug 3, 2026 · PPD ID: 2222222222']);
    // The chosen one's description, under the list.
    expect(within(row).getAllByRole('cell')[1]).toHaveTextContent(/PPD ID: 1111111111$/);
    await userEvent.selectOptions(which, 'p2');
    expect(within(row).getAllByRole('cell')[1]).toHaveTextContent(/PPD ID: 2222222222$/);
    await userEvent.click(screen.getByRole('button', { name: 'Link' }));
    await expect.poll(() => sent('PATCH /api/transfers/p2')[0]?.body).toEqual({ status: 'confirmed' });
    await userEvent.click(screen.getByRole('button', { name: 'Not a transfer' }));
    await expect.poll(() => [sent('PATCH /api/transfers/p1')[0]?.body, sent('PATCH /api/transfers/p2')[1]?.body]).toEqual([{ status: 'rejected' }, { status: 'rejected' }]);
  });

  it('filters by a preset, dates and a search', async () => {
    server.use(http.get('*/api/accounts/brk/transactions', ({ request }) => {
      const url = new URL(request.url);
      return HttpResponse.json(url.searchParams.get('q') === 'nothing' ? { ...BROKERAGE, transactions: [], matched: 0 } : BROKERAGE);
    }));
    renderPage(<Transactions />, { route: '/?account=brk' });
    await screen.findByText('Funds Received');
    const lastQuery = () => sent('GET /api/accounts/brk/transactions').at(-1)!.url.searchParams;
    // The last month to begin with.
    expect(screen.getByRole('tab', { name: '1M', selected: true })).toBeInTheDocument();
    expect(lastQuery().get('from')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await userEvent.click(screen.getByRole('tab', { name: 'YTD' }));
    await expect.poll(() => lastQuery().get('from')).toMatch(/^\d{4}-01-01$/);
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-06-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-06-30' } });
    await expect.poll(() => [lastQuery().get('from'), lastQuery().get('to')]).toEqual(['2026-06-01', '2026-06-30']);
    // A start after the end: the end goes.
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-07-01' } });
    await expect.poll(() => [lastQuery().get('from'), lastQuery().get('to')]).toEqual(['2026-07-01', null]);
    await userEvent.type(screen.getByLabelText('Search'), 'nothing');
    await expect.poll(() => lastQuery().get('q')).toBe('nothing');
    expect(await screen.findByText('No transactions match')).toBeInTheDocument();
    // All clears the dates.
    await userEvent.click(screen.getByRole('tab', { name: 'All' }));
    await expect.poll(() => lastQuery().has('from')).toBe(false);
  });

  it("lists every account's transactions to begin with, each with its account and in its account's currency", async () => {
    server.use(
      http.get('*/api/transactions', () =>
        HttpResponse.json({
          ...CHECKING,
          kind: 'all',
          transactions: [
            entry('a1', '2026-10-02', { accountId: 'wbc', currency: 'AUD', source: 'import', kind: 'withdrawal', automatic: 'withdrawal', description: 'Example Grocer', amount: 45_00 }),
            entry('a2', '2026-10-01', { accountId: 'chk', source: 'report', kind: 'income', automatic: 'income', description: 'Interest', amount: -12_34 }),
          ],
        } satisfies TransactionsResponse),
      ),
    );
    renderPage(<Transactions />);
    expect(screen.getByLabelText('Account')).toHaveValue('all');
    const grocer = (await screen.findByText('Example Grocer')).closest('tr')!;
    // Its name already starts with its institution's, so it isn't repeated.
    expect(grocer).toHaveTextContent('Example Bank Everyday');
    expect(grocer).toHaveTextContent('-$45.00');
    expect(screen.getByText('Interest').closest('tr')).toHaveTextContent('Northwind Checking ··1234');
  });
});
