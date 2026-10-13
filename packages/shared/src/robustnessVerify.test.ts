import { describe, expect, it } from 'vitest';
import { runBacktest, type BacktestRound } from './backtest.js';
import type { TwoLegStrategyConfig } from './legs.js';
import {
  ROBUSTNESS_ALGORITHM_VERSION,
  RobustnessResultError,
  runBlockRobustness,
  verifyBlockRobustnessResult,
  type BlockRobustnessResult,
  type RobustnessExpectations,
} from './robustness.js';
import type { SimulationSettings } from './simulation.js';

// SYNTHETIC TEST FIXTURES: invented multipliers and times, used only to exercise verification.

const strategy: TwoLegStrategyConfig = {
  schemaVersion: 1,
  currency: 'NGN',
  legs: {
    A: { label: 'A', enabled: true, stakeMinor: 100, cashoutTargetX100: 200 },
    B: { label: 'B', enabled: true, stakeMinor: 50, cashoutTargetX100: 500 },
  },
};
const settings: SimulationSettings = {
  schemaVersion: 1,
  currency: 'NGN',
  startingBankrollMinor: 10_000,
  insufficientBankrollPolicy: 'skip_leg',
  risk: {
    stopBelowBankrollMinor: null,
    stopAtOrAboveBankrollMinor: null,
    maxDrawdownBps: 9_000,
    maxRounds: null,
  },
};

const rounds: BacktestRound[] = Array.from({ length: 100 }, (_, i) => ({
  roundId: 10 + i * 2,
  multiplierX100: [100, 130, 210, 150, 520, 101, 190, 330][i % 8]!,
  eventAt: new Date(Date.UTC(2026, 2, 1) + i * 9_000).toISOString(),
}));

function valid(): BlockRobustnessResult {
  return runBlockRobustness(rounds, strategy, settings, { windows: 3 });
}

function expectations(overrides: Partial<RobustnessExpectations> = {}): RobustnessExpectations {
  return {
    windows: 3,
    sampleSize: rounds.length,
    strategy,
    settings,
    observedSummary: runBacktest(rounds, strategy, settings).summary,
    rounds,
    ...overrides,
  };
}

/** Applies a mutation to a deep copy of a valid result and returns the verification issues. */
function issuesAfter(
  mutate: (r: BlockRobustnessResult) => void,
  overrides: Partial<RobustnessExpectations> = {},
): string[] {
  const copy = structuredClone(valid());
  mutate(copy);
  try {
    verifyBlockRobustnessResult(copy, expectations(overrides));
  } catch (error) {
    expect(error).toBeInstanceOf(RobustnessResultError);
    return [...(error as RobustnessResultError).issues];
  }
  return [];
}

describe('verifyBlockRobustnessResult', () => {
  it('accepts the engine output, including after a JSON round trip', () => {
    const result = valid();
    expect(verifyBlockRobustnessResult(result, expectations())).toEqual(result);
    const json = JSON.parse(JSON.stringify(result)) as unknown;
    expect(verifyBlockRobustnessResult(json, expectations())).toEqual(result);
  });

  it('compares the observed summary structurally, whatever its key order', () => {
    const observed = runBacktest(rounds, strategy, settings).summary;
    const reordered = Object.fromEntries(Object.entries(observed).reverse()) as typeof observed;
    expect(() =>
      verifyBlockRobustnessResult(valid(), expectations({ observedSummary: reordered })),
    ).not.toThrow();
  });

  it('rejects malformed JSON with field paths', () => {
    expect(() => verifyBlockRobustnessResult({}, expectations())).toThrow(RobustnessResultError);
    expect(issuesAfter((r) => delete (r as Partial<BlockRobustnessResult>).full)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^full:/)]),
    );
  });

  it('rejects unsupported algorithm versions', () => {
    expect(issuesAfter((r) => (r.algorithmVersion = 'chronological-blocks/v0'))).toEqual([
      expect.stringMatching(/unsupported algorithm version/),
    ]);
    expect(ROBUSTNESS_ALGORITHM_VERSION).toBe('chronological-blocks/v1');
  });

  it('rejects a window count that disagrees with the request or the blocks', () => {
    expect(issuesAfter(() => {}, { windows: 4 })).toEqual(
      expect.arrayContaining([expect.stringMatching(/3 windows; 4 were requested/)]),
    );
    expect(issuesAfter((r) => r.blocks.pop())).toEqual(
      expect.arrayContaining([expect.stringMatching(/2 blocks for 3 windows/)]),
    );
  });

  it('rejects a sample size that disagrees with the source', () => {
    expect(issuesAfter(() => {}, { sampleSize: 99 })).toEqual(
      expect.arrayContaining([expect.stringMatching(/the sample has 99/)]),
    );
  });

  it('rejects gaps, overlaps, bad indices and wrong last indices', () => {
    expect(
      issuesAfter((r) => {
        r.blocks[1]!.startIndex += 1;
        r.blocks[1]!.roundCount -= 1;
      }),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/gap before block 1/)]));
    expect(
      issuesAfter((r) => {
        r.blocks[1]!.startIndex -= 1;
        r.blocks[1]!.roundCount += 1;
      }),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/block 1 overlaps/)]));
    expect(issuesAfter((r) => (r.blocks[2]!.index = 5))).toEqual(
      expect.arrayContaining([expect.stringMatching(/block 2 has index 5/)]),
    );
    expect(
      issuesAfter((r) => {
        r.blocks[2]!.endIndex -= 1;
        r.blocks[2]!.roundCount -= 1;
      }),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/not at the sample size 100/)]));
    expect(issuesAfter((r) => (r.blocks[0]!.endIndex += 1))).toEqual(
      expect.arrayContaining([expect.stringMatching(/boundaries do not match its round count/)]),
    );
  });

  it('rejects blocks that are contiguous but differ from the chronological partition', () => {
    // 100 rounds in 3 blocks is 34, 33, 33; shifting a boundary keeps contiguity but not the plan.
    expect(
      issuesAfter((r) => {
        r.blocks[0]!.endIndex -= 1;
        r.blocks[0]!.roundCount -= 1;
        r.blocks[1]!.startIndex -= 1;
        r.blocks[1]!.roundCount += 1;
      }),
    ).toEqual(
      expect.arrayContaining([expect.stringMatching(/differ from the chronological partition/)]),
    );
  });

  it('rejects non-canonical, out-of-order or inconsistent event times', () => {
    expect(issuesAfter((r) => (r.blocks[1]!.firstEventAt = '2026-03-01T01:00:00Z'))).toEqual(
      expect.arrayContaining([expect.stringMatching(/not canonical UTC/)]),
    );
    expect(issuesAfter((r) => (r.blocks[1]!.firstEventAt = '2026-02-30T00:00:00.000Z'))).toEqual(
      expect.arrayContaining([expect.stringMatching(/not canonical UTC/)]),
    );
    expect(
      issuesAfter((r) => {
        [r.blocks[1]!.firstEventAt, r.blocks[1]!.lastEventAt] = [
          r.blocks[1]!.lastEventAt,
          r.blocks[1]!.firstEventAt,
        ];
      }),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/block 1 times are not increasing/)]));
    expect(issuesAfter((r) => (r.blocks[2]!.firstEventAt = r.blocks[0]!.lastEventAt))).toEqual(
      expect.arrayContaining([expect.stringMatching(/block 2 does not start after block 1 ends/)]),
    );
    expect(issuesAfter((r) => (r.full.firstEventAt = r.blocks[1]!.firstEventAt))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/first block does not start at the sample start/),
      ]),
    );
  });

  it('rejects round ids or times that do not match the source rounds', () => {
    expect(issuesAfter((r) => (r.blocks[1]!.firstRoundId += 2))).toEqual([
      expect.stringMatching(/block 1 round ids or times do not match the source rounds/),
    ]);
    const shifted = rounds.map((r) => ({ ...r, roundId: r.roundId + 1 }));
    expect(issuesAfter(() => {}, { rounds: shifted })).toHaveLength(3);
    expect(issuesAfter(() => {}, { rounds: rounds.slice(1) })).toEqual(
      expect.arrayContaining([expect.stringMatching(/the source has 99 rounds/)]),
    );
  });

  it('rejects summaries that do not reconcile or do not match the configuration', () => {
    expect(issuesAfter((r) => (r.blocks[0]!.summary.netProfitMinor += 1))).toEqual(
      expect.arrayContaining([expect.stringMatching(/block 0: ending bankroll != starting/)]),
    );
    expect(issuesAfter((r) => (r.blocks[2]!.summary.startingBankrollMinor = 9_999))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/block 2: did not start from the configured bankroll/),
      ]),
    );
    expect(issuesAfter((r) => (r.blocks[1]!.summary.roundsAvailable = 34))).toEqual(
      expect.arrayContaining([expect.stringMatching(/block 1: roundsAvailable is not 33/)]),
    );
    const otherStrategy = structuredClone(strategy);
    otherStrategy.legs.A.cashoutTargetX100 = 300;
    expect(issuesAfter(() => {}, { strategy: otherStrategy })).toEqual(
      expect.arrayContaining([expect.stringMatching(/leg A does not match the strategy/)]),
    );
    expect(
      issuesAfter(() => {}, { settings: { ...settings, startingBankrollMinor: 20_000 } }),
    ).toEqual(
      expect.arrayContaining([expect.stringMatching(/did not start from the configured bankroll/)]),
    );
  });

  it("rejects a full-sample result that differs from the run's stored summary", () => {
    const observed = structuredClone(runBacktest(rounds, strategy, settings).summary);
    observed.longestLosingStreak += 1;
    expect(issuesAfter(() => {}, { observedSummary: observed })).toEqual([
      expect.stringMatching(/differs from the run's stored result/),
    ]);
  });

  it('never repairs a result: the input is left unchanged', () => {
    const broken = structuredClone(valid());
    broken.blocks[1]!.startIndex += 1;
    const before = JSON.stringify(broken);
    expect(() => verifyBlockRobustnessResult(broken, expectations())).toThrow(
      RobustnessResultError,
    );
    expect(JSON.stringify(broken)).toBe(before);
  });
});
