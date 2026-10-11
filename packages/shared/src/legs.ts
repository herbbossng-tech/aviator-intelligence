import { z } from 'zod';
import { currencyCodeSchema, positiveMinorAmountSchema } from './money.js';
import { cashoutTargetX100Schema } from './multiplier.js';

/**
 * A strategy consists of two independently configurable SIMULATED legs (A and B).
 * Configuring legs does not place bets and does not imply that any configuration
 * is profitable. These types describe inputs to future simulations only.
 */
export const LEG_KEYS = ['A', 'B'] as const;
export const legKeySchema = z.enum(LEG_KEYS);
export type LegKey = z.infer<typeof legKeySchema>;

export const legConfigSchema = z
  .object({
    label: z.string().trim().min(1, 'Leg label is required').max(40),
    enabled: z.boolean(),
    /** Virtual stake per round, in minor units. */
    stakeMinor: positiveMinorAmountSchema,
    /** Auto-cashout target, x100 (2.00x = 200). */
    cashoutTargetX100: cashoutTargetX100Schema,
  })
  .strict();
export type LegConfig = z.infer<typeof legConfigSchema>;

export const twoLegStrategyConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    currency: currencyCodeSchema,
    legs: z.object({ A: legConfigSchema, B: legConfigSchema }).strict(),
  })
  .strict()
  .refine((config) => config.legs.A.enabled || config.legs.B.enabled, {
    message: 'At least one leg must be enabled',
    path: ['legs'],
  });
export type TwoLegStrategyConfig = z.infer<typeof twoLegStrategyConfigSchema>;

/**
 * ILLUSTRATIVE SAMPLE ONLY. These stakes and targets are placeholders showing the
 * shape of a configuration. They are not recommended, tested or proven settings.
 */
export const SAMPLE_TWO_LEG_CONFIG: TwoLegStrategyConfig = {
  schemaVersion: 1,
  currency: 'NGN',
  legs: {
    A: { label: 'Leg A (sample)', enabled: true, stakeMinor: 50_000, cashoutTargetX100: 200 },
    B: { label: 'Leg B (sample)', enabled: true, stakeMinor: 50_000, cashoutTargetX100: 600 },
  },
};
