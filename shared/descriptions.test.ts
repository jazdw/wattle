import { describe, expect, it } from 'vitest';
import { categoryWords, fullDescription } from './descriptions';

describe('descriptions', () => {
  it("joins a file's NAME and MEMO", () => {
    expect(fullDescription('Payment', 'Ref 1234')).toBe('Payment · Ref 1234');
    expect(fullDescription('Online Transfer 12345678901 to E', 'xample savings')).toBe('Online Transfer 12345678901 to Example savings');
    expect(fullDescription(null, null)).toBeNull();
  });

  it("puts Plaid's category in words", () => {
    expect(categoryWords('FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES')).toBe('Food and drink · Groceries');
    expect(categoryWords('BANK_FEES', 'BANK_FEES_OVERDRAFT_FEES')).toBe('Bank fees · Overdraft fees');
    expect(categoryWords('INCOME', null)).toBe('Income');
    expect(categoryWords(null, 'TRANSFER_IN_DEPOSIT')).toBe('Transfer in deposit');
    expect(categoryWords(null, null)).toBeNull();
  });
});
