import { describe, expect, it } from 'vitest';
import { stackAreas } from './series';

describe('stackAreas', () => {
  const other = { key: '__other', label: 'Other (3)', color: 'grey', values: [50, -20, null, 10] };
  const cash = { key: 'cash', label: 'Cash', color: 'green', values: [100, 120, 130, 140] };

  it('stacks a series that crosses zero as its parts above and below zero, so it never jumps across the stack', () => {
    expect(stackAreas([cash, other], true)).toEqual([
      cash,
      { ...other, values: [50, 0, null, 10] },
      { ...other, key: '__other:below', values: [0, -20, null, 0] },
    ]);
  });

  it('leaves series alone when not stacked, or when they stay on one side', () => {
    expect(stackAreas([cash, other], false)).toEqual([cash, other]);
    expect(stackAreas([cash], true)).toEqual([cash]);
  });
});
