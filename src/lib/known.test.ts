import { describe, expect, it } from 'vitest';
import { csvAccounts } from './csv';
import { balanceRows, withKnown } from './known';

// Made up: a cash account's export with no balance in it.
const cash = csvAccounts('Date,Amount\n2026-09-01,500.00\n2026-09-15,-200.00\n2026-09-15,-50.00')![0]!;
// Made up: one fund bought twice, and its dividend paid in cash.
const funds = csvAccounts('Date,Type,Symbol,Shares,Price,Amount\n2026-01-05,Buy,VTI,10,100,1000\n2026-02-05,Buy,VTI,5,100,500\n2026-03-31,Dividend,VTI,0,0,12')![0]!;

describe('withKnown', () => {
  it('works out a cash account from its balance at the end, or the same balance at the start, alike', () => {
    expect(withKnown(cash, undefined)).toBeNull();
    expect(withKnown(cash, { at: 'end', cash: null, shares: {} })).toBeNull();
    const fromEnd = withKnown(cash, { at: 'end', cash: 1250, shares: {} })!;
    expect(fromEnd.file).toMatchObject({ kind: 'balances', currency: undefined, rows: [{ date: '2026-09-01', balance: 1500 }, { date: '2026-09-15', balance: 1250 }] });
    // The transactions are kept, for the account's transactions.
    expect(fromEnd.file.kind === 'balances' && fromEnd.file.transactions?.map((txn) => [txn.date, txn.kind, txn.amount])).toEqual([
      ['2026-09-01', 'deposit', 500_00],
      ['2026-09-15', 'withdrawal', -200_00],
      ['2026-09-15', 'withdrawal', -50_00],
    ]);
    // $1,000 before the first transaction leads to the same $1,250 at the end, and the day before is known too.
    const fromStart = withKnown(cash, { at: 'start', cash: 1000, shares: {} })!;
    expect(fromStart.file.kind === 'balances' && fromStart.file.rows).toEqual([{ date: '2026-08-31', balance: 1000 }, ...(fromEnd.file.kind === 'balances' ? fromEnd.file.rows : [])]);
  });

  it('works out holdings forwards from what was held at the start, or uses what is held at the end', () => {
    // The dividend is paid in cash, so the account's cash is needed too.
    expect(withKnown(funds, { at: 'start', cash: null, shares: { VTI: 0 } })).toBeNull();
    const forwards = withKnown(funds, { at: 'start', cash: 1500, shares: { VTI: 0 } })!;
    expect(forwards.file).toMatchObject({ kind: 'holdings', asOf: '2026-03-31', positions: [{ security: 'VTI', shares: 15, price: 100 }], cash: 12_00 });
    const backwards = withKnown(funds, { at: 'end', cash: 12, shares: { VTI: 15 } })!;
    expect(backwards.file).toEqual(forwards.file);
  });
});

describe('balanceRows', () => {
  it('gives what is owed for a card', () => {
    expect(balanceRows([{ date: '2026-09-10', amount: -100_00 }], -300_00, '2026-09-30', '2026-09-01', true)).toEqual([
      { date: '2026-09-01', balance: 200 },
      { date: '2026-09-10', balance: 300 },
      { date: '2026-09-30', balance: 300 },
    ]);
  });
});
