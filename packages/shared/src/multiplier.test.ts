import { describe, expect, it } from 'vitest';
import {
  cashoutTargetX100Schema,
  formatMultiplierX100,
  parseMultiplierX100,
  roundMultiplierX100Schema,
} from './multiplier.js';

describe('parseMultiplierX100', () => {
  it.each([
    ['1', 100],
    ['1.00', 100],
    ['2.5', 250],
    ['2.35', 235],
    ['2.35x', 235],
    [' 10.01X ', 1001],
    ['1000000', 100_000_000],
  ])('parses %s as %d', (input, expected) => {
    expect(parseMultiplierX100(input)).toBe(expected);
  });

  it.each(['', 'abc', '2.345', '-2', '0.99', '1,5', '1e3', '1000000.01'])('rejects %j', (input) => {
    expect(() => parseMultiplierX100(input)).toThrow();
  });
});

describe('formatMultiplierX100', () => {
  it('formats x100 integers with two decimals', () => {
    expect(formatMultiplierX100(100)).toBe('1.00x');
    expect(formatMultiplierX100(235)).toBe('2.35x');
    expect(formatMultiplierX100(600)).toBe('6.00x');
  });
});

describe('multiplier schemas', () => {
  it('requires round multipliers >= 1.00x and integer', () => {
    expect(roundMultiplierX100Schema.safeParse(100).success).toBe(true);
    expect(roundMultiplierX100Schema.safeParse(99).success).toBe(false);
    expect(roundMultiplierX100Schema.safeParse(150.5).success).toBe(false);
  });

  it('requires cashout targets >= 1.01x', () => {
    expect(cashoutTargetX100Schema.safeParse(100).success).toBe(false);
    expect(cashoutTargetX100Schema.safeParse(101).success).toBe(true);
  });
});
