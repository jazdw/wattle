import { describe, expect, it } from 'vitest';
import { balanceRows } from './known';

describe('balanceRows', () => {
  it('gives what is owed for a card', () => {
    expect(balanceRows([{ date: '2026-09-10', amount: -100_00 }], -300_00, '2026-09-30', '2026-09-01', true)).toEqual([
      { date: '2026-09-01', balance: 200 },
      { date: '2026-09-10', balance: 300 },
      { date: '2026-09-30', balance: 300 },
    ]);
  });
});
