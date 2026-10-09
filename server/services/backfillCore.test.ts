import { describe, expect, it } from 'vitest';
import { reconstructHistory } from './backfillCore';

const flat = (price: number) => () => ({ price, estimated: false });

describe('reconstructHistory', () => {
  it('walks buys and sells backwards from current holdings', () => {
    const days = reconstructHistory({
      start: '2026-01-01',
      end: '2026-01-05',
      holdings: [{ securityId: 'A', quantity: 10 }],
      transactions: [
        { date: '2026-01-03', securityId: 'A', quantity: 4, amount: 400_00 },
        { date: '2026-01-02', securityId: 'A', quantity: 6, amount: 600_00 },
      ],
      cashSecurityId: null,
      price: flat(100),
    });
    expect(days.map((day) => [day.date, day.positions[0]?.quantity])).toEqual([
      ['2026-01-02', 6],
      ['2026-01-03', 10],
      ['2026-01-04', 10],
      ['2026-01-05', 10],
    ]);
    expect(days[0].total).toBe(600_00);
    expect(days.every((day) => !day.estimated)).toBe(true);
  });

  it('rebuilds cash from transaction amounts', () => {
    const days = reconstructHistory({
      start: '2026-01-01',
      end: '2026-01-03',
      holdings: [
        { securityId: 'A', quantity: 5 },
        { securityId: 'CASH', quantity: 50 },
      ],
      transactions: [
        // Bought 5 shares at $10 on the 3rd, after depositing $100 on the 2nd.
        { date: '2026-01-03', securityId: 'A', quantity: 5, amount: 50_00 },
        { date: '2026-01-02', securityId: null, quantity: 0, amount: -100_00 },
      ],
      cashSecurityId: 'CASH',
      price: flat(10),
    });
    const cash = (index: number) => days[index].positions.find((position) => position.securityId === 'CASH')?.quantity;
    expect(days[0].date).toBe('2026-01-02');
    expect(cash(0)).toBe(100);
    expect(cash(1)).toBe(50);
    expect(days.at(-1)!.total).toBe(100_00);
  });

  it('clamps impossible states and marks earlier days estimated', () => {
    const days = reconstructHistory({
      start: '2026-01-01',
      end: '2026-01-03',
      holdings: [{ securityId: 'A', quantity: 1 }],
      // An in-kind transfer the institution never reported leaves a gap.
      transactions: [{ date: '2026-01-03', securityId: 'A', quantity: 3, amount: 0 }],
      cashSecurityId: null,
      price: flat(1),
    });
    expect(days.at(-1)!.estimated).toBe(false);
    expect(days.find((day) => day.date === '2026-01-02')?.estimated ?? true).toBe(true);
  });
});
