import { describe, expect, it } from 'vitest';
import { formatMinorAmount, minorAmountSchema, positiveMinorAmountSchema } from './money.js';

describe('formatMinorAmount', () => {
  it('formats integer minor units without floating-point conversion', () => {
    expect(formatMinorAmount(50_000, 'NGN')).toBe('₦500.00');
    expect(formatMinorAmount(123_456_789, 'USD')).toBe('$1,234,567.89');
    expect(formatMinorAmount(5, 'GBP')).toBe('£0.05');
    expect(formatMinorAmount(-1_050, 'EUR')).toBe('-€10.50');
  });

  it('rejects non-integer amounts', () => {
    expect(() => formatMinorAmount(10.5, 'NGN')).toThrow(RangeError);
  });
});

describe('amount schemas', () => {
  it('accept only integers in range', () => {
    expect(minorAmountSchema.safeParse(0).success).toBe(true);
    expect(minorAmountSchema.safeParse(-1).success).toBe(false);
    expect(minorAmountSchema.safeParse(1.5).success).toBe(false);
    expect(positiveMinorAmountSchema.safeParse(0).success).toBe(false);
  });
});
