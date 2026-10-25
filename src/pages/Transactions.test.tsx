import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { TransactionEntry, TransactionsResponse } from '../../shared/types';
import { renderPage } from '../test/render';
import { server } from '../test/server';
import { Transactions } from './Transactions';

const entry = (id: string, date: string, extra: Partial<TransactionEntry>): TransactionEntry => ({
  id,
  date,
  type: null,
  subtype: null,
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
  truncated: false,
  transactions: [
    entry('t2', '2026-09-01', { type: 'buy', subtype: 'buy', ticker: 'VXUS', description: 'Buy', quantity: 100, price: 60.25, amount: 6025_00 }),
    entry('t1', '2026-09-01', { type: 'cash', subtype: 'deposit', ticker: 'CUR:USD', description: 'Funds Received', amount: -10000_00 }),
  ],
};

const CHECKING: TransactionsResponse = {
  kind: 'bank',
  currency: 'USD',
  from: '2026-10-01',
  to: '2026-10-01',
  truncated: false,
  transactions: [entry('b1', '2026-10-01', { description: 'Interest', amount: -12_34 })],
};

describe('Transactions', () => {
  it("shows an investment account's transactions, money in as positive, and how far back Plaid's go", async () => {
    server.use(
      http.get('*/api/accounts/brk/transactions', () => HttpResponse.json(BROKERAGE)),
      http.get('*/api/accounts/chk/transactions', () => HttpResponse.json(CHECKING)),
    );
    renderPage(<Transactions />);
    expect(await screen.findByText('Funds Received')).toBeInTheDocument();
    expect(screen.getByText(/Plaid has transactions from/)).toHaveTextContent('Plaid has transactions from Jun 2, 2026 to Sep 1, 2026');
    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0]).getByText('Buy', { selector: 'td' })).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent('-$6,025.00');
    expect(rows[1]).toHaveTextContent('Deposit');
    expect(rows[1]).toHaveTextContent('$10,000.00');

    // A bank account: its report's transactions.
    await userEvent.selectOptions(screen.getByLabelText('Account'), 'chk');
    expect(await screen.findByText('Interest')).toBeInTheDocument();
    expect(screen.getByText(/Bank history reports have transactions/)).toBeInTheDocument();
  });
});
