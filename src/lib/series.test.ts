import { describe, expect, it } from 'vitest';
import { stackAreas } from './series';

describe('stackAreas', () => {
  const other = { key: '__other', label: 'Other (3)', color: 'grey', values: [50, -20, null, 10] };
  const cash = { key: 'cash', label: 'Cash', color: 'green', values: [100, 120, 130, 140] };

  it('stacks a series that crosses zero as its parts above and below zero, so it never jumps across the stack', () => {
    expect(stackAreas([cash, other], true)).toEqual([
      cash,
      // Each part is left out where it's zero (recharts would stack a zero above zero).
      { ...other, values: [50, null, null, 10], gaps: true },
      { ...other, key: '__other:below', values: [null, -20, null, null], gaps: true },
    ]);
  });

  it('leaves series alone when not stacked, or when they stay on one side', () => {
    expect(stackAreas([cash, other], false)).toEqual([cash, other]);
    expect(stackAreas([cash], true)).toEqual([cash]);
  });

  it('leaves a series below zero out where it is zero (a card paid off)', () => {
    const card = { key: 'card', label: 'Card', color: 'red', values: [-300, 0, null, -50] };
    expect(stackAreas([card], true)).toEqual([{ ...card, values: [-300, null, null, -50], gaps: true }]);
  });
});
