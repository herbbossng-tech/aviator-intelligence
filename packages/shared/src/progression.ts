import { z } from 'zod';
import { currencyCodeSchema, MAX_MINOR_AMOUNT, positiveMinorAmountSchema } from './money.js';
import { cashoutTargetX100Schema, MULTIPLIER_SCALE } from './multiplier.js';

/**
 * Virtual staking progressions (fixed, Martingale, capped Martingale, custom sequence) as a
 * pure, deterministic state machine. See docs/PROGRESSION.md.
 *
 * VIRTUAL MONEY ONLY. The engine never predicts a round: it only says what stake a
 * configuration requests next, and records a win or loss that the CALLER observed or
 * simulated. No progression guarantees recovery or profit; every limit blocks rather than
 * bends, and a blocked progression stays blocked.
 *
 * Conventions:
 * - Money is integer minor units; multipliers are integers x100 (2.00x = 200).
 * - Steps are ZERO-BASED: step 0 is the base stake; step k is the stake after k consecutive
 *   losses in the current cycle. A cycle starts at step 0 and ends with a win (reset to base).
 * - Martingale stakes use a closed form, rounded UP to a whole minor unit:
 *     stake(k) = ceil(base * m^k / 100^k)   (m = multiplierX100)
 *   computed exactly with BigInt (never compounding rounding errors from step to step).
 * - The engine is not yet connected to the historical backtester.
 */

export const PROGRESSION_STATE_SCHEMA_VERSION = 1;
/** Hard upper bound on steps in one cycle, for every mode. */
export const MAX_PROGRESSION_STEPS = 1_000;
export const MAX_CUSTOM_SEQUENCE_LENGTH = 100;
/** Progression multipliers from 1.01x to 10.00x (x100). */
export const MIN_PROGRESSION_MULTIPLIER_X100 = 101;
export const MAX_PROGRESSION_MULTIPLIER_X100 = 1_000;

export const PROGRESSION_MODES = ['fixed', 'martingale', 'capped_martingale', 'custom'] as const;
export type ProgressionMode = (typeof PROGRESSION_MODES)[number];

/** What a win does. Only the conventional policy is supported: back to the base stake. */
export const WIN_RESET_POLICIES = ['reset_to_base'] as const;
const winResetPolicySchema = z.enum(WIN_RESET_POLICIES);

export const PROGRESSION_BLOCK_REASONS = [
  'max_steps_reached',
  'max_stake_exceeded',
  'cycle_exposure_exceeded',
  'insufficient_bankroll',
] as const;
export type ProgressionBlockReason = (typeof PROGRESSION_BLOCK_REASONS)[number];

export const PROGRESSION_BLOCK_TEXT: Record<ProgressionBlockReason, string> = {
  max_steps_reached: 'The progression reached its configured maximum number of steps.',
  max_stake_exceeded: 'The next stake would exceed the configured maximum stake.',
  cycle_exposure_exceeded:
    "The next stake plus this cycle's losses would exceed the configured maximum exposure.",
  insufficient_bankroll: 'The virtual bankroll cannot fund the next stake.',
};

const stepsSchema = z.number().int().min(1).max(MAX_PROGRESSION_STEPS);
const multiplierSchema = z
  .number()
  .int()
  .min(MIN_PROGRESSION_MULTIPLIER_X100)
  .max(MAX_PROGRESSION_MULTIPLIER_X100);

const common = {
  schemaVersion: z.literal(1),
  currency: currencyCodeSchema,
  winResetPolicy: winResetPolicySchema,
};

const fixedSchema = z
  .object({
    ...common,
    mode: z.literal('fixed'),
    baseStakeMinor: positiveMinorAmountSchema,
    limits: z
      .object({
        /** Maximum stakes in one cycle, i.e. consecutive losses allowed before blocking. */
        maxSteps: stepsSchema,
        maxStakeMinor: positiveMinorAmountSchema.nullable(),
        maxCycleExposureMinor: positiveMinorAmountSchema.nullable(),
      })
      .strict(),
  })
  .strict();

const martingaleSchema = z
  .object({
    ...common,
    mode: z.literal('martingale'),
    baseStakeMinor: positiveMinorAmountSchema,
    multiplierX100: multiplierSchema,
    limits: z
      .object({
        maxSteps: stepsSchema,
        maxStakeMinor: positiveMinorAmountSchema.nullable(),
        /** Required: losses so far in the cycle plus the next stake may not exceed this. */
        maxCycleExposureMinor: positiveMinorAmountSchema,
      })
      .strict(),
  })
  .strict();

const cappedMartingaleSchema = z
  .object({
    ...common,
    mode: z.literal('capped_martingale'),
    baseStakeMinor: positiveMinorAmountSchema,
    multiplierX100: multiplierSchema,
    limits: z
      .object({
        maxSteps: stepsSchema,
        /** Required: no single stake may exceed this. */
        maxStakeMinor: positiveMinorAmountSchema,
        maxCycleExposureMinor: positiveMinorAmountSchema.nullable(),
      })
      .strict(),
  })
  .strict();

const customSchema = z
  .object({
    ...common,
    mode: z.literal('custom'),
    /** Stake for each step, in order; step 0 is the base stake. Never extended. */
    stakesMinor: z.array(positiveMinorAmountSchema).min(1).max(MAX_CUSTOM_SEQUENCE_LENGTH),
    /** After a loss on the final step there is no further stake: the sequence is exhausted. */
    afterFinalStep: z.literal('stop'),
    limits: z
      .object({
        maxStakeMinor: positiveMinorAmountSchema.nullable(),
        maxCycleExposureMinor: positiveMinorAmountSchema.nullable(),
      })
      .strict(),
  })
  .strict();

const configUnion = z.discriminatedUnion('mode', [
  fixedSchema,
  martingaleSchema,
  cappedMartingaleSchema,
  customSchema,
]);

export type ProgressionConfig = z.infer<typeof configUnion>;

// ---------------------------------------------------------------------------
// Exact arithmetic
// ---------------------------------------------------------------------------

const MAX_MINOR = BigInt(MAX_MINOR_AMOUNT);

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * Martingale stake for zero-based step k: ceil(base * m^k / 100^k), exact. Throws RangeError
 * for invalid inputs or a result above MAX_MINOR_AMOUNT (never returns a rounded figure).
 */
export function martingaleStakeMinor(
  baseStakeMinor: number,
  multiplierX100: number,
  step: number,
): number {
  if (!positiveMinorAmountSchema.safeParse(baseStakeMinor).success) {
    throw new RangeError('The base stake must be a positive integer amount in minor units');
  }
  if (!multiplierSchema.safeParse(multiplierX100).success) {
    throw new RangeError(
      `The multiplier must be an integer x100 from ${MIN_PROGRESSION_MULTIPLIER_X100} to ${MAX_PROGRESSION_MULTIPLIER_X100}`,
    );
  }
  if (!Number.isSafeInteger(step) || step < 0 || step >= MAX_PROGRESSION_STEPS) {
    throw new RangeError(`The step must be an integer from 0 to ${MAX_PROGRESSION_STEPS - 1}`);
  }
  const stake = rawMartingaleStake(BigInt(baseStakeMinor), BigInt(multiplierX100), step);
  if (stake > MAX_MINOR) {
    throw new RangeError(`The stake at step ${step} exceeds ${MAX_MINOR_AMOUNT} minor units`);
  }
  return Number(stake);
}

function rawMartingaleStake(base: bigint, multiplierX100: bigint, step: number): bigint {
  const k = BigInt(step);
  return ceilDiv(base * multiplierX100 ** k, BigInt(MULTIPLIER_SCALE) ** k);
}

function maxStepsOf(config: ProgressionConfig): number {
  return config.mode === 'custom' ? config.stakesMinor.length : config.limits.maxSteps;
}

/** Exact requested stake at a step (may exceed MAX_MINOR_AMOUNT; compare before converting). */
function stakeAt(config: ProgressionConfig, step: number): bigint {
  switch (config.mode) {
    case 'fixed':
      return BigInt(config.baseStakeMinor);
    case 'martingale':
    case 'capped_martingale':
      return rawMartingaleStake(BigInt(config.baseStakeMinor), BigInt(config.multiplierX100), step);
    case 'custom':
      return BigInt(config.stakesMinor[step]!);
  }
}

/** Sum of the stakes of steps 0..step-1: the losses of a cycle that has reached `step`. */
function cycleLossAt(config: ProgressionConfig, step: number): bigint {
  let total = 0n;
  for (let i = 0; i < step; i++) total += stakeAt(config, i);
  return total;
}

/** The configured cap (if any) that blocks the stake at `step`, given that cycle's losses. */
function capReason(
  config: ProgressionConfig,
  step: number,
  cycleLoss: bigint,
): Exclude<ProgressionBlockReason, 'insufficient_bankroll'> | 'sequence_exhausted' | null {
  if (step >= maxStepsOf(config)) {
    return config.mode === 'custom' ? 'sequence_exhausted' : 'max_steps_reached';
  }
  const stake = stakeAt(config, step);
  const { maxStakeMinor, maxCycleExposureMinor } = config.limits;
  if (maxStakeMinor !== null && stake > BigInt(maxStakeMinor)) return 'max_stake_exceeded';
  if (maxCycleExposureMinor !== null && cycleLoss + stake > BigInt(maxCycleExposureMinor)) {
    return 'cycle_exposure_exceeded';
  }
  return null;
}

/**
 * The configuration schema. Beyond field checks, the base stake must itself pass every cap,
 * and every stake the progression can actually request (each step until the step limit or the
 * first step a configured cap blocks) must be at most MAX_MINOR_AMOUNT. The second check is
 * defensive: with the required caps (each at most MAX_MINOR_AMOUNT) a cap always blocks first.
 */
export const progressionConfigSchema = configUnion.superRefine((config, ctx) => {
  const blockedAtStart = capReason(config, 0, 0n);
  if (blockedAtStart !== null) {
    ctx.addIssue({
      code: 'custom',
      message: `The base stake is already blocked by the configuration (${blockedAtStart}).`,
      path: ['limits'],
    });
    return;
  }
  let loss = 0n;
  for (let step = 0; step < maxStepsOf(config); step++) {
    if (capReason(config, step, loss) !== null) return; // later steps are unreachable
    const stake = stakeAt(config, step);
    if (stake > MAX_MINOR) {
      ctx.addIssue({
        code: 'custom',
        message: `The stake at step ${step} would exceed ${MAX_MINOR_AMOUNT} minor units; lower the step limit or add a stake or exposure cap.`,
        path: ['limits'],
      });
      return;
    }
    loss += stake;
  }
});

// ---------------------------------------------------------------------------
// Errors and identity
// ---------------------------------------------------------------------------

export const PROGRESSION_ERROR_CODES = [
  'invalid_config',
  'invalid_state',
  'config_mismatch',
  'invalid_input',
  'decision_pending',
  'no_pending_decision',
  'decision_mismatch',
] as const;
export type ProgressionErrorCode = (typeof PROGRESSION_ERROR_CODES)[number];

/** Invalid configuration, state or input, or an illegal transition. Never repaired. */
export class ProgressionError extends Error {
  constructor(
    readonly code: ProgressionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProgressionError';
  }
}

/** Parses a configuration, throwing ProgressionError('invalid_config') with every issue. */
export function parseProgressionConfig(input: unknown): ProgressionConfig {
  const parsed = progressionConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new ProgressionError(
      'invalid_config',
      parsed.error.issues
        .slice(0, 10)
        .map((i) => `${i.path.join('.') || 'config'}: ${i.message}`)
        .join('; '),
    );
  }
  return parsed.data;
}

/**
 * A deterministic identifier of a parsed configuration: FNV-1a (64-bit) of its canonical JSON.
 * It guards against continuing a state under different settings by accident; it is not a
 * cryptographic hash.
 */
export function progressionConfigKey(input: unknown): string {
  const config = parseProgressionConfig(input);
  let hash = 0xcbf29ce484222325n;
  for (const char of JSON.stringify(config)) {
    hash ^= BigInt(char.charCodeAt(0));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export const PROGRESSION_STATUSES = ['ready', 'awaiting_result', 'blocked', 'exhausted'] as const;
export type ProgressionStatus = (typeof PROGRESSION_STATUSES)[number];

/**
 * Serializable progression state. Fields are minimal; everything derivable is checked:
 * - `step` (zero-based) is also the number of consecutive losses in the current cycle.
 * - `cycleLossMinor` must equal the sum of the stakes of steps 0..step-1.
 * - `pendingDecision` exists only while `awaiting_result`; its id is `resolvedCount` and its
 *   stake must equal the configured stake for `step`.
 * - `blockReason` exists only while `blocked`, and must be what the configuration implies.
 */
export const progressionStateSchema = z
  .object({
    schemaVersion: z.literal(PROGRESSION_STATE_SCHEMA_VERSION),
    configKey: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/),
    status: z.enum(PROGRESSION_STATUSES),
    step: z.number().int().min(0).max(MAX_PROGRESSION_STEPS),
    cycleLossMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    /** Wins so far: each win completes a cycle and resets to step 0. */
    cyclesCompleted: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    /** Wins plus losses recorded so far. */
    resolvedCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    pendingDecision: z
      .object({
        decisionId: z.number().int().min(0),
        stakeMinor: positiveMinorAmountSchema,
      })
      .strict()
      .nullable(),
    blockReason: z.enum(PROGRESSION_BLOCK_REASONS).nullable(),
  })
  .strict();
export type ProgressionState = z.infer<typeof progressionStateSchema>;

/**
 * Parses a state and checks it against its configuration: same configuration key, consistent
 * loss accounting, a pending decision only when awaiting a result, and a block reason that the
 * configuration actually implies. Throws ProgressionError; never repairs a state.
 */
export function parseProgressionState(configInput: unknown, stateInput: unknown): ProgressionState {
  const config = parseProgressionConfig(configInput);
  const parsed = progressionStateSchema.safeParse(stateInput);
  if (!parsed.success) {
    throw new ProgressionError(
      'invalid_state',
      parsed.error.issues
        .slice(0, 10)
        .map((i) => `${i.path.join('.') || 'state'}: ${i.message}`)
        .join('; '),
    );
  }
  const state = parsed.data;
  const fail = (message: string): never => {
    throw new ProgressionError('invalid_state', message);
  };
  if (state.configKey !== progressionConfigKey(config)) {
    throw new ProgressionError(
      'config_mismatch',
      'This state was created under a different progression configuration.',
    );
  }
  if (state.step > maxStepsOf(config)) fail('step is beyond the configured number of steps');
  const loss = cycleLossAt(config, state.step);
  if (BigInt(state.cycleLossMinor) !== loss) {
    fail('cycleLossMinor does not equal the stakes lost in this cycle');
  }
  if (state.cyclesCompleted + state.step > state.resolvedCount) {
    fail('more wins and current-cycle losses than resolved results');
  }
  const cap = capReason(config, state.step, loss);
  switch (state.status) {
    case 'ready':
      if (state.pendingDecision !== null || state.blockReason !== null) {
        fail('a ready state has no pending decision and no block reason');
      }
      break;
    case 'awaiting_result':
      if (state.blockReason !== null) fail('an awaiting state has no block reason');
      if (cap !== null) fail('a decision is pending at a step the configuration blocks');
      if (
        state.pendingDecision === null ||
        state.pendingDecision.decisionId !== state.resolvedCount ||
        BigInt(state.pendingDecision.stakeMinor) !== stakeAt(config, state.step)
      ) {
        fail('the pending decision does not match the current step');
      }
      break;
    case 'blocked': {
      if (state.pendingDecision !== null) fail('a blocked state has no pending decision');
      // A configured cap must block here exactly as recorded; otherwise only the
      // bankroll (an input the state does not record) can have blocked it.
      if (cap === 'sequence_exhausted' || state.blockReason !== (cap ?? 'insufficient_bankroll')) {
        fail('the block reason does not match the configuration and step');
      }
      break;
    }
    case 'exhausted':
      if (state.pendingDecision !== null || state.blockReason !== null) {
        fail('an exhausted state has no pending decision and no block reason');
      }
      if (cap !== 'sequence_exhausted') fail('only a completed custom sequence is exhausted');
      break;
  }
  return state;
}

/** A fresh progression at step 0 with no results. */
export function createProgressionState(configInput: unknown): ProgressionState {
  return {
    schemaVersion: PROGRESSION_STATE_SCHEMA_VERSION,
    configKey: progressionConfigKey(configInput),
    status: 'ready',
    step: 0,
    cycleLossMinor: 0,
    cyclesCompleted: 0,
    resolvedCount: 0,
    pendingDecision: null,
    blockReason: null,
  };
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export type ProgressionDecision =
  | {
      kind: 'stake';
      /** Bind the result to this decision when resolving it. */
      decisionId: number;
      /** Zero-based step in the current cycle. */
      step: number;
      stakeMinor: number;
      cycleLossBeforeMinor: number;
      /** What this cycle will have lost if this stake loses too. */
      exposureIfLostMinor: number;
      state: ProgressionState;
    }
  | {
      kind: 'blocked';
      reason: ProgressionBlockReason;
      message: string;
      step: number;
      /** The stake the configuration requests at this step, or null if there is none. */
      requestedStakeMinor: number | null;
      cycleLossMinor: number;
      state: ProgressionState;
    }
  | {
      kind: 'exhausted';
      reason: 'sequence_exhausted';
      message: string;
      step: number;
      cycleLossMinor: number;
      state: ProgressionState;
    };

export interface DecisionInput {
  /** The virtual bankroll available for this decision (read, never changed). */
  availableBankrollMinor: number;
}

function blockedDecision(
  config: ProgressionConfig,
  state: ProgressionState,
  reason: ProgressionBlockReason,
): ProgressionDecision {
  const requested = state.step < maxStepsOf(config) ? stakeAt(config, state.step) : null;
  return {
    kind: 'blocked',
    reason,
    message: PROGRESSION_BLOCK_TEXT[reason],
    step: state.step,
    requestedStakeMinor: requested !== null && requested <= MAX_MINOR ? Number(requested) : null,
    cycleLossMinor: state.cycleLossMinor,
    state: { ...state, status: 'blocked', pendingDecision: null, blockReason: reason },
  };
}

/**
 * Decides the next stake. Checks, in order: the step limit (custom sequences are then
 * exhausted), the maximum stake, the cycle exposure limit, then the available bankroll. Any
 * failure returns a blocked decision whose state stays blocked: the stake is never lowered,
 * a cap never raised and the cycle never reset to make a stake fit. A blocked or exhausted
 * state returns the same decision again. Throws ProgressionError for invalid input or state,
 * or if a decision is already pending.
 */
export function decideNextStake(
  configInput: unknown,
  stateInput: unknown,
  input: DecisionInput,
): ProgressionDecision {
  const config = parseProgressionConfig(configInput);
  const state = parseProgressionState(config, stateInput);
  const bankroll = input?.availableBankrollMinor;
  if (!Number.isSafeInteger(bankroll) || bankroll < 0) {
    throw new ProgressionError(
      'invalid_input',
      'availableBankrollMinor must be a non-negative safe integer in minor units',
    );
  }
  if (state.status === 'awaiting_result') {
    throw new ProgressionError(
      'decision_pending',
      `Decision ${state.pendingDecision!.decisionId} must be resolved before another is made.`,
    );
  }
  if (state.status === 'blocked') return blockedDecision(config, state, state.blockReason!);
  const exhausted = (): ProgressionDecision => ({
    kind: 'exhausted',
    reason: 'sequence_exhausted',
    message: 'The custom sequence has no further step after a loss on its final step.',
    step: state.step,
    cycleLossMinor: state.cycleLossMinor,
    state: { ...state, status: 'exhausted' },
  });
  if (state.status === 'exhausted') return exhausted();

  const cap = capReason(config, state.step, BigInt(state.cycleLossMinor));
  if (cap === 'sequence_exhausted') return exhausted();
  if (cap !== null) return blockedDecision(config, state, cap);
  const stake = stakeAt(config, state.step);
  if (stake > MAX_MINOR) {
    // Unreachable for a valid configuration (the schema checks every reachable step).
    throw new ProgressionError('invalid_config', 'The stake exceeds the representable range.');
  }
  if (stake > BigInt(bankroll)) return blockedDecision(config, state, 'insufficient_bankroll');

  const stakeMinor = Number(stake);
  return {
    kind: 'stake',
    decisionId: state.resolvedCount,
    step: state.step,
    stakeMinor,
    cycleLossBeforeMinor: state.cycleLossMinor,
    exposureIfLostMinor: state.cycleLossMinor + stakeMinor,
    state: {
      ...state,
      status: 'awaiting_result',
      pendingDecision: { decisionId: state.resolvedCount, stakeMinor },
    },
  };
}

export const PROGRESSION_OUTCOMES = ['win', 'loss'] as const;
export type ProgressionOutcome = (typeof PROGRESSION_OUTCOMES)[number];

export interface ResolutionInput {
  decisionId: number;
  /** Observed or simulated by the caller; the engine never invents a result. */
  outcome: ProgressionOutcome;
}

export interface ProgressionResolution {
  decisionId: number;
  outcome: ProgressionOutcome;
  stakeMinor: number;
  cycleLossBeforeMinor: number;
  /** 0 after a win (a new cycle starts); losses so far after a loss. */
  cycleLossAfterMinor: number;
  /** True when this win completed the cycle and reset to the base stake. */
  cycleReset: boolean;
  state: ProgressionState;
}

/**
 * Records the result of the pending decision. A loss adds the stake to the cycle's losses and
 * advances one step; a win (policy reset_to_base) completes the cycle and returns to step 0
 * with no losses carried over. Throws ProgressionError if nothing is pending, the decision id
 * does not match (including a second resolution of the same decision), or the input is invalid.
 */
export function resolveStake(
  configInput: unknown,
  stateInput: unknown,
  input: ResolutionInput,
): ProgressionResolution {
  const config = parseProgressionConfig(configInput);
  const state = parseProgressionState(config, stateInput);
  if (!PROGRESSION_OUTCOMES.includes(input?.outcome)) {
    throw new ProgressionError('invalid_input', "outcome must be 'win' or 'loss'");
  }
  if (state.status !== 'awaiting_result' || state.pendingDecision === null) {
    throw new ProgressionError(
      'no_pending_decision',
      'There is no pending stake decision to resolve.',
    );
  }
  if (input.decisionId !== state.pendingDecision.decisionId) {
    throw new ProgressionError(
      'decision_mismatch',
      `Decision ${String(input.decisionId)} is not the pending decision ${state.pendingDecision.decisionId}.`,
    );
  }
  const { stakeMinor, decisionId } = state.pendingDecision;
  const before = state.cycleLossMinor;
  const resolvedCount = state.resolvedCount + 1;
  const next: ProgressionState =
    input.outcome === 'win'
      ? {
          ...state,
          status: 'ready',
          step: 0,
          cycleLossMinor: 0,
          cyclesCompleted: state.cyclesCompleted + 1,
          resolvedCount,
          pendingDecision: null,
        }
      : {
          ...state,
          status: 'ready',
          step: state.step + 1,
          cycleLossMinor: before + stakeMinor,
          resolvedCount,
          pendingDecision: null,
        };
  return {
    decisionId,
    outcome: input.outcome,
    stakeMinor,
    cycleLossBeforeMinor: before,
    cycleLossAfterMinor: next.cycleLossMinor,
    cycleReset: input.outcome === 'win',
    state: next,
  };
}

/**
 * Net of a progression cycle that ends with a win: floor(s * c / 100) - s - L, where s is the
 * winning stake, c the cashout target x100 and L the cycle's earlier losses. This matches the
 * backtest's settlement rule (gross return floor(s * c / 100), including the stake) and equals
 * s * (c - 1) - L when s * c is a whole number of minor units. It assumes the target is
 * reached and ignores fees; it does not mean the win is likely, affordable or recovers L.
 */
export function cycleNetAfterWinMinor(
  stakeMinor: number,
  cashoutTargetX100: number,
  priorCycleLossMinor: number,
): number {
  if (!positiveMinorAmountSchema.safeParse(stakeMinor).success) {
    throw new RangeError('The stake must be a positive integer amount in minor units');
  }
  if (!cashoutTargetX100Schema.safeParse(cashoutTargetX100).success) {
    throw new RangeError('The cashout target must be an integer x100 of at least 101');
  }
  if (!Number.isSafeInteger(priorCycleLossMinor) || priorCycleLossMinor < 0) {
    throw new RangeError('Prior cycle losses must be a non-negative safe integer');
  }
  const gross = (BigInt(stakeMinor) * BigInt(cashoutTargetX100)) / BigInt(MULTIPLIER_SCALE);
  const net = gross - BigInt(stakeMinor) - BigInt(priorCycleLossMinor);
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (net > max || net < -max) throw new RangeError('The cycle net exceeds the safe integer range');
  return Number(net);
}
