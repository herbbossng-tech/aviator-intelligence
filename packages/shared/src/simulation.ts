import { z } from 'zod';
import {
  currencyCodeSchema,
  MAX_MINOR_AMOUNT,
  minorAmountSchema,
  positiveMinorAmountSchema,
} from './money.js';
import { MULTIPLIER_SCALE, roundMultiplierX100Schema } from './multiplier.js';
import type { LegConfig } from './legs.js';

/**
 * Simulation configuration types, used by the backtest engine in backtest.ts. These
 * schemas define and validate what a run accepts and how runs are stored.
 * All risk settings apply to VIRTUAL bankrolls only and control nothing outside this app.
 */
export const simulationRiskSettingsSchema = z
  .object({
    /** Stop the run if the virtual bankroll falls below this amount (minor units). */
    stopBelowBankrollMinor: minorAmountSchema.nullable(),
    /** Stop the run once the virtual bankroll reaches this amount (minor units). */
    stopAtOrAboveBankrollMinor: positiveMinorAmountSchema.nullable(),
    /** Stop the run if drawdown from peak exceeds this many basis points (100 bps = 1%). */
    maxDrawdownBps: z.number().int().min(1).max(10_000).nullable(),
    /** Maximum number of rounds to process. */
    maxRounds: z.number().int().min(1).max(10_000_000).nullable(),
  })
  .strict();
export type SimulationRiskSettings = z.infer<typeof simulationRiskSettingsSchema>;

export const simulationSettingsSchema = z
  .object({
    schemaVersion: z.literal(1),
    currency: currencyCodeSchema,
    startingBankrollMinor: positiveMinorAmountSchema,
    /** What to do when the virtual bankroll cannot cover an enabled leg's stake. */
    insufficientBankrollPolicy: z.enum(['skip_leg', 'stop_run']),
    risk: simulationRiskSettingsSchema,
  })
  .strict()
  .refine(
    (s) =>
      s.risk.stopAtOrAboveBankrollMinor === null ||
      s.risk.stopAtOrAboveBankrollMinor > s.startingBankrollMinor,
    {
      message: 'Upper stop must be above the starting bankroll',
      path: ['risk', 'stopAtOrAboveBankrollMinor'],
    },
  )
  .refine(
    (s) =>
      s.risk.stopBelowBankrollMinor === null ||
      s.risk.stopBelowBankrollMinor < s.startingBankrollMinor,
    {
      message: 'Lower stop must be below the starting bankroll',
      path: ['risk', 'stopBelowBankrollMinor'],
    },
  );
export type SimulationSettings = z.infer<typeof simulationSettingsSchema>;

export const datasetSelectionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('round_id_range'),
      fromRoundId: z.number().int().positive(),
      toRoundId: z.number().int().positive(),
    })
    .strict()
    .refine((r) => r.fromRoundId <= r.toRoundId, { message: 'fromRoundId must be <= toRoundId' }),
  z.object({ kind: z.literal('import'), importId: z.number().int().positive() }).strict(),
]);
export type DatasetSelection = z.infer<typeof datasetSelectionSchema>;

export const SIMULATION_RUN_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;
export type SimulationRunStatus = (typeof SIMULATION_RUN_STATUSES)[number];

export const LEDGER_RESULTS = ['win', 'loss', 'skipped'] as const;
export type LedgerResult = (typeof LEDGER_RESULTS)[number];

export interface LegSettlement {
  result: Exclude<LedgerResult, 'skipped'>;
  grossReturnMinor: number;
  netMinor: number;
}

/**
 * Settles one virtual leg against one round's crash multiplier.
 *
 * Modelling assumption (to be confirmed against the platform's published rules):
 * an auto-cashout at target T succeeds when the round's crash multiplier M >= T.
 * Gross return is stake * T / 100, rounded DOWN to the nearest minor unit (conservative).
 * This is a deterministic accounting rule, not a prediction of any outcome.
 */
export function settleLeg(
  leg: Pick<LegConfig, 'stakeMinor' | 'cashoutTargetX100'>,
  roundMultiplierX100: number,
): LegSettlement {
  roundMultiplierX100Schema.parse(roundMultiplierX100);
  if (
    !Number.isSafeInteger(leg.stakeMinor) ||
    leg.stakeMinor <= 0 ||
    leg.stakeMinor > MAX_MINOR_AMOUNT
  ) {
    throw new RangeError('Stake must be a positive integer amount in minor units');
  }
  if (roundMultiplierX100 >= leg.cashoutTargetX100) {
    const product = leg.stakeMinor * leg.cashoutTargetX100;
    if (!Number.isSafeInteger(product)) {
      throw new RangeError('Stake x target exceeds safe integer range');
    }
    const grossReturnMinor = Math.floor(product / MULTIPLIER_SCALE);
    return { result: 'win', grossReturnMinor, netMinor: grossReturnMinor - leg.stakeMinor };
  }
  return { result: 'loss', grossReturnMinor: 0, netMinor: -leg.stakeMinor };
}
