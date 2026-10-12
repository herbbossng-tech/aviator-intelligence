import { describe, expect, it } from 'vitest';
import {
  SAMPLE_TWO_LEG_CONFIG,
  twoLegStrategyConfigSchema,
  type TwoLegStrategyConfig,
} from './legs.js';

function withLegs(
  legs: Partial<Record<'A' | 'B', Partial<TwoLegStrategyConfig['legs']['A']>>>,
): unknown {
  return {
    ...SAMPLE_TWO_LEG_CONFIG,
    legs: {
      A: { ...SAMPLE_TWO_LEG_CONFIG.legs.A, ...legs.A },
      B: { ...SAMPLE_TWO_LEG_CONFIG.legs.B, ...legs.B },
    },
  };
}

describe('twoLegStrategyConfigSchema', () => {
  it('accepts the illustrative sample configuration', () => {
    expect(twoLegStrategyConfigSchema.parse(SAMPLE_TWO_LEG_CONFIG)).toEqual(SAMPLE_TWO_LEG_CONFIG);
  });

  it('allows the two legs to be configured independently', () => {
    const parsed = twoLegStrategyConfigSchema.parse(
      withLegs({
        A: { cashoutTargetX100: 150, stakeMinor: 10_000 },
        B: { cashoutTargetX100: 1_000, enabled: false },
      }),
    );
    expect(parsed.legs.A.cashoutTargetX100).toBe(150);
    expect(parsed.legs.B.enabled).toBe(false);
  });

  it('requires at least one enabled leg', () => {
    const result = twoLegStrategyConfigSchema.safeParse(
      withLegs({ A: { enabled: false }, B: { enabled: false } }),
    );
    expect(result.success).toBe(false);
  });

  it.each([
    ['zero stake', { stakeMinor: 0 }],
    ['fractional stake', { stakeMinor: 100.5 }],
    ['target of 1.00x', { cashoutTargetX100: 100 }],
    ['fractional target', { cashoutTargetX100: 200.5 }],
    ['blank label', { label: '   ' }],
  ])('rejects %s', (_name, override) => {
    expect(twoLegStrategyConfigSchema.safeParse(withLegs({ A: override })).success).toBe(false);
  });

  it('rejects unknown keys and unsupported currencies', () => {
    expect(
      twoLegStrategyConfigSchema.safeParse({ ...SAMPLE_TWO_LEG_CONFIG, extra: true }).success,
    ).toBe(false);
    expect(
      twoLegStrategyConfigSchema.safeParse({ ...SAMPLE_TWO_LEG_CONFIG, currency: 'XYZ' }).success,
    ).toBe(false);
  });
});
