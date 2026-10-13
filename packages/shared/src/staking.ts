import { z } from 'zod';
import { LEG_KEYS, type LegKey, type TwoLegStrategyConfig } from './legs.js';
import {
  progressionConfigSchema,
  type ProgressionBlockReason,
  type ProgressionConfig,
} from './progression.js';

/**
 * How each leg of a two-leg strategy stakes over a backtest. VIRTUAL MONEY ONLY.
 *
 * A staking plan is optional and additive: without one (or with `null` for a leg) the leg
 * stakes its configured `stakeMinor` every round, exactly as before. With a progression, the
 * leg's own progression decides each stake from that leg's own results; the leg's
 * `stakeMinor` is the progression's base stake (they must be equal). Progressions never share
 * state between legs. See docs/PROGRESSION.md and docs/SIMULATION.md.
 */
export const stakingPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    legs: z
      .object({
        A: progressionConfigSchema.nullable(),
        B: progressionConfigSchema.nullable(),
      })
      .strict(),
  })
  .strict();
export type StakingPlan = z.infer<typeof stakingPlanSchema>;

/** Why a leg's entry was skipped: a transient shortfall or a permanent progression limit. */
export const LEDGER_SKIP_REASONS = [
  'insufficient_bankroll',
  'max_steps_reached',
  'max_stake_exceeded',
  'cycle_exposure_exceeded',
  'sequence_exhausted',
] as const satisfies readonly (ProgressionBlockReason | 'sequence_exhausted')[];
export type LedgerSkipReason = (typeof LEDGER_SKIP_REASONS)[number];

function baseStakeOf(config: ProgressionConfig): number {
  return config.mode === 'custom' ? config.stakesMinor[0]! : config.baseStakeMinor;
}

/** Cross-checks a plan against the strategy it applies to. Returns problems (empty if none). */
export function stakingPlanIssues(
  plan: StakingPlan,
  strategy: TwoLegStrategyConfig,
): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = [];
  for (const key of LEG_KEYS) {
    const progression = plan.legs[key];
    if (progression === null) continue;
    const leg = strategy.legs[key];
    const path = ['staking', 'legs', key];
    if (!leg.enabled) {
      issues.push({ path, message: `Leg ${key} is disabled, so it cannot have a progression` });
    }
    if (progression.currency !== strategy.currency) {
      issues.push({
        path: [...path, 'currency'],
        message: 'The currency differs from the strategy',
      });
    }
    if (baseStakeOf(progression) !== leg.stakeMinor) {
      issues.push({
        path,
        message: `Leg ${key}'s progression must start at the leg's stake (${leg.stakeMinor} minor units)`,
      });
    }
  }
  return issues;
}

/** The legs a plan applies a progression to. */
export function progressionLegs(plan: StakingPlan | null): LegKey[] {
  return plan === null ? [] : LEG_KEYS.filter((k) => plan.legs[k] !== null);
}
