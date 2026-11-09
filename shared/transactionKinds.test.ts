import { describe, expect, it } from 'vitest';
import { bankKind, kindOf, plaidKind, type KindFacts } from './transactionKinds';

const plaid = (type: string, subtype: string | null, amount: number, quantity = 0): KindFacts => ({ source: 'plaid', kind: null, type, subtype, amount, quantity, description: null });

describe('transaction kinds', () => {
  it("reads Plaid's subtype before its type", () => {
    expect(plaidKind('buy', 'buy', 60_25, 1, false)).toBe('buy');
    expect(plaidKind('sell', 'sell', -60_25, -1, false)).toBe('sell');
    expect(plaidKind('buy', 'dividend reinvestment', 12_50, 0.2, false)).toBe('reinvest');
    // A buy of the account's cash fund only moves money within its cash.
    expect(plaidKind('buy', 'buy', 500_00, 500, true)).toBe('sweep');
    expect(plaidKind('cash', 'dividend', -12_50, 0, false)).toBe('income');
    // Some institutions file dividends under fee.
    expect(plaidKind('fee', 'qualified dividend', -12_50, 0, false)).toBe('income');
    // Interest paid out (on a margin loan) is a cost.
    expect(plaidKind('fee', 'interest', 3_00, 0, false)).toBe('fee');
    expect(plaidKind('fee', 'account fee', 20_00, 0, false)).toBe('fee');
    expect(plaidKind('fee', 'tax withheld', 1_80, 0, false)).toBe('fee');
    expect(plaidKind('cash', 'contribution', -1000_00, 0, false)).toBe('deposit');
    expect(plaidKind('cash', 'withdrawal', 1000_00, 0, false)).toBe('withdrawal');
    expect(plaidKind('cash', 'deposit', -1000_00, 0, true)).toBe('deposit');
    expect(plaidKind('transfer', 'split', 0, 100, false)).toBe('transfer');
    expect(plaidKind('transfer', 'transfer', -250_00, 0, false)).toBe('deposit');
  });

  it("leaves what it can't tell for you to set", () => {
    expect(plaidKind('cancel', 'cancel', -60_25, -1, false)).toBeNull();
    expect(plaidKind('cash', 'adjustment', -1_00, 0, false)).toBeNull();
    expect(plaidKind('mystery', null, 1_00, 0, false)).toBeNull();
  });

  it("reads a bank's transactions by their sign, and interest and fees by their description", () => {
    expect(bankKind(-2000_00, 'PAYROLL')).toBe('deposit');
    expect(bankKind(45_00, 'GROCERIES')).toBe('withdrawal');
    expect(bankKind(-1_23, 'INTEREST PAYMENT')).toBe('income');
    expect(bankKind(12_00, 'MONTHLY SERVICE FEE')).toBe('fee');
    expect(bankKind(4_50, 'COFFEE')).toBe('withdrawal');
  });

  it('uses the kind you set, then a file\'s own mapping', () => {
    expect(kindOf({ ...plaid('cash', 'dividend', -12_50), kind: 'deposit' })).toBe('deposit');
    expect(kindOf({ source: 'import', kind: null, type: 'Contribution', subtype: 'deposit', amount: -100_00, quantity: 0, description: null })).toBe('deposit');
    expect(kindOf({ source: 'import', kind: null, type: 'Odd', subtype: null, amount: -100_00, quantity: 0, description: null })).toBeNull();
    expect(kindOf({ source: 'report', kind: null, type: null, subtype: null, amount: 30_00, quantity: 0, description: 'CARD PAYMENT' })).toBe('withdrawal');
    expect(kindOf(plaid('buy', 'buy', 500_00, 500), true)).toBe('sweep');
  });
});
