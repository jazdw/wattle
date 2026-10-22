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

describe('reconstructHistory in windows', () => {
  it('returns exactly the days of the full rebuild, for any window', () => {
    const input = {
      start: '2026-01-01',
      end: '2026-03-31',
      holdings: [
        { securityId: 'vti', quantity: 10 },
        { securityId: 'cash', quantity: 500 },
      ],
      transactions: [
        { date: '2026-03-10', securityId: 'vti', quantity: 4, amount: 40_000 },
        { date: '2026-02-01', securityId: 'bnd', quantity: -3, amount: -21_000 }, // sold something not held now
        { date: '2026-01-20', securityId: 'vti', quantity: 20, amount: 200_000 }, // more than held: clamped, estimated before
        { date: '2026-01-15', securityId: null, quantity: 0, amount: -1_000_00 }, // a deposit
      ],
      cashSecurityId: 'cash',
      price: (securityId: string, date: string) => (securityId === 'bnd' && date < '2026-01-10' ? null : { price: date < '2026-02-15' ? 90 : 100, estimated: false }),
    };
    const full = reconstructHistory(input);
    expect(full.length).toBeGreaterThan(30);
    for (const [emitFrom, emitTo] of [
      ['2026-01-01', '2026-01-31'],
      ['2026-02-01', '2026-02-28'],
      ['2026-03-01', '2026-03-31'],
      ['2026-01-18', '2026-01-22'],
      ['2026-03-31', '2026-03-31'],
    ]) {
      const window = reconstructHistory({ ...input, emitFrom, emitTo });
      expect(window, `${emitFrom}..${emitTo}`).toEqual(full.filter((day) => day.date >= emitFrom && day.date <= emitTo));
    }
  });

  it('keeps empty days after the account first held something, and drops those before', () => {
    const input = {
      start: '2026-01-01',
      end: '2026-01-31',
      holdings: [{ securityId: 'vti', quantity: 1 }],
      transactions: [
        { date: '2026-01-25', securityId: 'vti', quantity: 1, amount: 100 }, // bought back
        { date: '2026-01-15', securityId: 'vti', quantity: -1, amount: -100 }, // sold out
        { date: '2026-01-10', securityId: 'vti', quantity: 1, amount: 100 }, // first buy
      ],
      cashSecurityId: null,
      price: () => ({ price: 1, estimated: false }),
    };
    const full = reconstructHistory(input);
    expect(full[0].date).toBe('2026-01-10');
    const middle = reconstructHistory({ ...input, emitFrom: '2026-01-16', emitTo: '2026-01-20' });
    expect(middle.map((day) => day.positions.length)).toEqual([0, 0, 0, 0, 0]);
    expect(reconstructHistory({ ...input, emitFrom: '2026-01-01', emitTo: '2026-01-09' })).toEqual([]);
  });
});
