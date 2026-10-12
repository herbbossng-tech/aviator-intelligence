import { describe, expect, it } from 'vitest';
import {
  datasetSelectionSchema,
  settleLeg,
  simulationSettingsSchema,
  type SimulationSettings,
} from './simulation.js';

const baseSettings: SimulationSettings = {
  schemaVersion: 1,
  currency: 'NGN',
  startingBankrollMinor: 1_000_000,
  insufficientBankrollPolicy: 'skip_leg',
  risk: {
    stopBelowBankrollMinor: null,
    stopAtOrAboveBankrollMinor: null,
    maxDrawdownBps: null,
    maxRounds: null,
  },
};

describe('settleLeg', () => {
  const leg = { stakeMinor: 50_000, cashoutTargetX100: 200 };

  it('wins when the crash multiplier reaches the target', () => {
    expect(settleLeg(leg, 200)).toEqual({
      result: 'win',
      grossReturnMinor: 100_000,
      netMinor: 50_000,
    });
    expect(settleLeg(leg, 735)).toEqual({
      result: 'win',
      grossReturnMinor: 100_000,
      netMinor: 50_000,
    });
  });

  it('loses the stake when the round crashes below the target', () => {
    expect(settleLeg(leg, 199)).toEqual({ result: 'loss', grossReturnMinor: 0, netMinor: -50_000 });
    expect(settleLeg(leg, 100)).toEqual({ result: 'loss', grossReturnMinor: 0, netMinor: -50_000 });
  });

  it('rounds gross return down to the minor unit', () => {
    // 333 * 1.55 = 516.15 -> 516
    expect(settleLeg({ stakeMinor: 333, cashoutTargetX100: 155 }, 300).grossReturnMinor).toBe(516);
  });

  it('settles exactly when stake x target exceeds 2^53 but the return itself is safe', () => {
    // 10^12 * 500_000 = 5e17 (> MAX_SAFE_INTEGER); gross = 5e15 minor units, exactly.
    expect(settleLeg({ stakeMinor: 1e12, cashoutTargetX100: 500_000 }, 500_000)).toEqual({
      result: 'win',
      grossReturnMinor: 5e15,
      netMinor: 5e15 - 1e12,
    });
    // Odd values: floor((10^12 - 1) * 333_333 / 100) computed exactly.
    const exact = (999_999_999_999n * 333_333n) / 100n;
    expect(
      settleLeg({ stakeMinor: 999_999_999_999, cashoutTargetX100: 333_333 }, 400_000)
        .grossReturnMinor,
    ).toBe(Number(exact));
  });

  it('refuses a return that cannot be represented exactly', () => {
    expect(() =>
      settleLeg({ stakeMinor: 1e12, cashoutTargetX100: 100_000_000 }, 100_000_000),
    ).toThrow(RangeError);
  });

  it('rejects invalid round multipliers and stakes', () => {
    expect(() => settleLeg(leg, 99)).toThrow();
    expect(() => settleLeg(leg, 150.5)).toThrow();
    expect(() => settleLeg({ stakeMinor: 0, cashoutTargetX100: 200 }, 300)).toThrow(RangeError);
  });
});

describe('simulationSettingsSchema', () => {
  it('accepts valid settings', () => {
    expect(simulationSettingsSchema.safeParse(baseSettings).success).toBe(true);
  });

  it('rejects stops on the wrong side of the starting bankroll', () => {
    const badUpper = {
      ...baseSettings,
      risk: { ...baseSettings.risk, stopAtOrAboveBankrollMinor: 500_000 },
    };
    const badLower = {
      ...baseSettings,
      risk: { ...baseSettings.risk, stopBelowBankrollMinor: 2_000_000 },
    };
    expect(simulationSettingsSchema.safeParse(badUpper).success).toBe(false);
    expect(simulationSettingsSchema.safeParse(badLower).success).toBe(false);
  });

  it('rejects out-of-range drawdown limits', () => {
    const bad = { ...baseSettings, risk: { ...baseSettings.risk, maxDrawdownBps: 10_001 } };
    expect(simulationSettingsSchema.safeParse(bad).success).toBe(false);
  });
});

describe('datasetSelectionSchema', () => {
  it('validates round ranges', () => {
    expect(
      datasetSelectionSchema.safeParse({ kind: 'round_id_range', fromRoundId: 1, toRoundId: 10 })
        .success,
    ).toBe(true);
    expect(
      datasetSelectionSchema.safeParse({ kind: 'round_id_range', fromRoundId: 10, toRoundId: 1 })
        .success,
    ).toBe(false);
    expect(datasetSelectionSchema.safeParse({ kind: 'import', importId: 3 }).success).toBe(true);
  });
});
