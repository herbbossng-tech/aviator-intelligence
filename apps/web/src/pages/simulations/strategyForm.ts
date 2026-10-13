import {
  LEG_KEYS,
  MAX_CUSTOM_SEQUENCE_LENGTH,
  MAX_PROGRESSION_MULTIPLIER_X100,
  MAX_PROGRESSION_STEPS,
  MIN_PROGRESSION_MULTIPLIER_X100,
  parseMajorAmountToMinor,
  parseMultiplierX100,
  progressionConfigSchema,
  SAMPLE_TWO_LEG_CONFIG,
  type BacktestRequestInput,
  type CurrencyCode,
  type LegKey,
  type ProgressionConfig,
  type ProgressionMode,
  type StakingPlan,
} from '@aviator/shared';

/**
 * The Strategy Lab form keeps every value as typed text and converts it only when the user
 * checks or runs a backtest: money to integer minor units, multipliers to x100 integers.
 * The server re-validates everything; these checks only give faster, field-level feedback.
 */
export interface LegDraft {
  enabled: boolean;
  label: string;
  stake: string;
  target: string;
}

/** How a leg stakes: its fixed stake every round ('flat') or a progression. */
export type StakingMode = 'flat' | ProgressionMode;

export const STAKING_MODE_LABELS: Record<StakingMode, string> = {
  flat: 'Flat (same stake every round)',
  fixed: 'Fixed progression (same stake, step limit)',
  martingale: 'Martingale (multiply after a loss)',
  capped_martingale: 'Capped Martingale (multiply, with a stake cap)',
  custom: 'Custom sequence',
};

/**
 * One leg's staking progression, as typed. The progression's base stake is always the leg's
 * own stake, so it is not entered here.
 */
export interface StakingDraft {
  mode: StakingMode;
  multiplier: string;
  maxSteps: string;
  maxStake: string;
  maxExposure: string;
  sequence: string;
}

export function initialStakingDraft(): StakingDraft {
  return {
    mode: 'flat',
    multiplier: '2.00',
    maxSteps: '',
    maxStake: '',
    maxExposure: '',
    sequence: '',
  };
}

export interface StrategyDraft {
  currency: CurrencyCode;
  legs: Record<LegKey, LegDraft>;
  staking: Record<LegKey, StakingDraft>;
  bankroll: string;
  policy: 'skip_leg' | 'stop_run';
  stopBelow: string;
  stopAtOrAbove: string;
  maxDrawdownPercent: string;
  maxRounds: string;
  source: string;
  importId: string;
  eventFrom: string;
  eventTo: string;
}

/** Field ids used for inputs, error messages and server error mapping. */
export type FieldId =
  | `leg${LegKey}-label`
  | `leg${LegKey}-stake`
  | `leg${LegKey}-target`
  | `leg${LegKey}-mode`
  | `leg${LegKey}-multiplier`
  | `leg${LegKey}-maxSteps`
  | `leg${LegKey}-maxStake`
  | `leg${LegKey}-maxExposure`
  | `leg${LegKey}-sequence`
  | 'legs'
  | 'bankroll'
  | 'policy'
  | 'stopBelow'
  | 'stopAtOrAbove'
  | 'maxDrawdownPercent'
  | 'maxRounds'
  | 'source'
  | 'importId'
  | 'eventFrom'
  | 'eventTo';

export type FieldErrors = Partial<Record<FieldId, string>>;

function majorText(minor: number): string {
  return (minor / 100).toFixed(2).replace(/\.00$/, '');
}

/**
 * Starting values for the form. The legs come from the ILLUSTRATIVE sample configuration
 * (2.00x and 6.00x); they are editable placeholders, not recommendations.
 */
export function initialDraft(): StrategyDraft {
  const sample = SAMPLE_TWO_LEG_CONFIG;
  const leg = (key: LegKey): LegDraft => ({
    enabled: sample.legs[key].enabled,
    label: `Leg ${key}`,
    stake: majorText(sample.legs[key].stakeMinor),
    target: (sample.legs[key].cashoutTargetX100 / 100).toFixed(2),
  });
  return {
    currency: sample.currency,
    legs: { A: leg('A'), B: leg('B') },
    staking: { A: initialStakingDraft(), B: initialStakingDraft() },
    bankroll: '10000',
    policy: 'skip_leg',
    stopBelow: '',
    stopAtOrAbove: '',
    maxDrawdownPercent: '',
    maxRounds: '',
    source: '',
    importId: '',
    eventFrom: '',
    eventTo: '',
  };
}

const POSITIVE_INT = /^\d{1,9}$/;

/** Converts the draft to an API request, or returns field errors. */
export function buildRequest(
  draft: StrategyDraft,
): { request: BacktestRequestInput; errors?: undefined } | { errors: FieldErrors } {
  const errors: FieldErrors = {};
  const money = (text: string, field: FieldId, { optional = false, positive = true } = {}) => {
    if (optional && text.trim() === '') return null;
    const value = parseMajorAmountToMinor(text, draft.currency);
    if (value === null) {
      errors[field] = 'Enter an amount such as 500 or 500.50 (at most two decimals).';
      return null;
    }
    if (positive && value <= 0) {
      errors[field] = 'Must be greater than zero.';
      return null;
    }
    return value;
  };

  const legs = {} as BacktestRequestInput['strategy']['legs'];
  for (const key of LEG_KEYS) {
    const d = draft.legs[key];
    const label = d.label.trim();
    if (label === '' || label.length > 40) errors[`leg${key}-label`] = 'Use 1–40 characters.';
    const stake = money(d.stake, `leg${key}-stake`) ?? 0;
    let target = 0;
    try {
      target = parseMultiplierX100(d.target);
      if (target < 101) errors[`leg${key}-target`] = 'A cashout target must be at least 1.01x.';
    } catch {
      errors[`leg${key}-target`] = 'Enter a multiplier such as 2 or 2.35 (at most two decimals).';
    }
    legs[key] = { label, enabled: d.enabled, stakeMinor: stake, cashoutTargetX100: target };
  }
  if (!draft.legs.A.enabled && !draft.legs.B.enabled) errors.legs = 'Enable at least one leg.';

  const bankroll = money(draft.bankroll, 'bankroll') ?? 0;
  const stopBelow = money(draft.stopBelow, 'stopBelow', { optional: true, positive: false });
  const stopAtOrAbove = money(draft.stopAtOrAbove, 'stopAtOrAbove', { optional: true });
  let maxDrawdownBps: number | null = null;
  if (draft.maxDrawdownPercent.trim() !== '') {
    const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(draft.maxDrawdownPercent.trim());
    const bps = match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')) : NaN;
    if (!(bps >= 1 && bps <= 10_000)) {
      errors.maxDrawdownPercent = 'Enter a percentage between 0.01 and 100.';
    } else {
      maxDrawdownBps = bps;
    }
  }
  let maxRounds: number | null = null;
  if (draft.maxRounds.trim() !== '') {
    const text = draft.maxRounds.trim();
    if (!POSITIVE_INT.test(text) || Number(text) < 1) {
      errors.maxRounds = 'Enter a whole number of rounds (1 or more).';
    } else {
      maxRounds = Number(text);
    }
  }
  if (bankroll > 0) {
    for (const key of LEG_KEYS) {
      if (legs[key].enabled && legs[key].stakeMinor > bankroll && !errors[`leg${key}-stake`]) {
        errors[`leg${key}-stake`] = 'The stake is larger than the starting bankroll.';
      }
    }
    if (stopBelow !== null && stopBelow >= bankroll) {
      errors.stopBelow = 'Must be below the starting bankroll.';
    }
    if (stopAtOrAbove !== null && stopAtOrAbove <= bankroll) {
      errors.stopAtOrAbove = 'Must be above the starting bankroll.';
    }
  }

  const staking = stakingInput(draft, legs, money, errors);
  const dataset = datasetInput(draft, errors);
  if (Object.keys(errors).length > 0) return { errors };
  return {
    request: {
      strategy: { schemaVersion: 1, currency: draft.currency, legs },
      settings: {
        schemaVersion: 1,
        currency: draft.currency,
        startingBankrollMinor: bankroll,
        insufficientBankrollPolicy: draft.policy,
        risk: {
          stopBelowBankrollMinor: stopBelow,
          stopAtOrAboveBankrollMinor: stopAtOrAbove,
          maxDrawdownBps,
          maxRounds,
        },
      },
      dataset: {
        source: dataset.source,
        importId: dataset.importId === undefined ? null : Number(dataset.importId),
        eventFrom: dataset.eventFrom ?? null,
        eventTo: dataset.eventTo ?? null,
      },
      // Sent only when some leg uses a progression, so flat runs are requested exactly as before.
      ...(staking === null ? {} : { staking }),
    },
  };
}

type MoneyParser = (
  text: string,
  field: FieldId,
  options?: { optional?: boolean; positive?: boolean },
) => number | null;

/**
 * The staking plan for the draft, or null when every leg is flat. Each progression starts at
 * its leg's stake; the shared schema then checks the whole configuration (for example that no
 * step's stake overflows), and any problem is reported on that leg's staking mode.
 */
function stakingInput(
  draft: StrategyDraft,
  legs: BacktestRequestInput['strategy']['legs'],
  money: MoneyParser,
  errors: FieldErrors,
): StakingPlan | null {
  const plan: StakingPlan = { schemaVersion: 1, legs: { A: null, B: null } };
  for (const key of LEG_KEYS) {
    const d = draft.staking[key];
    if (d.mode === 'flat') continue;
    if (!legs[key].enabled) {
      errors[`leg${key}-mode`] = 'Enable the leg or set it back to flat stakes.';
      continue;
    }
    const base = legs[key].stakeMinor;
    const before = Object.keys(errors).length;
    const field = (name: 'multiplier' | 'maxSteps' | 'maxStake' | 'maxExposure' | 'sequence') =>
      `leg${key}-${name}` as const;
    const required = (text: string, name: 'maxStake' | 'maxExposure') => {
      if (text.trim() === '') {
        errors[field(name)] = 'Required for this mode.';
        return null;
      }
      return money(text, field(name));
    };
    const multiplier = (): number => {
      try {
        const value = parseMultiplierX100(d.multiplier);
        if (value >= MIN_PROGRESSION_MULTIPLIER_X100 && value <= MAX_PROGRESSION_MULTIPLIER_X100) {
          return value;
        }
      } catch {
        // Reported below.
      }
      errors[field('multiplier')] =
        `Enter a multiplier from ${MIN_PROGRESSION_MULTIPLIER_X100 / 100} to ${MAX_PROGRESSION_MULTIPLIER_X100 / 100} (at most two decimals).`;
      return 0;
    };
    const steps = (): number => {
      const text = d.maxSteps.trim();
      if (!POSITIVE_INT.test(text) || Number(text) < 1 || Number(text) > MAX_PROGRESSION_STEPS) {
        errors[field('maxSteps')] = `Enter a whole number from 1 to ${MAX_PROGRESSION_STEPS}.`;
        return 0;
      }
      return Number(text);
    };
    const common = { schemaVersion: 1, currency: draft.currency, winResetPolicy: 'reset_to_base' };
    let config: unknown;
    switch (d.mode) {
      case 'fixed':
        config = {
          ...common,
          mode: 'fixed',
          baseStakeMinor: base,
          limits: {
            maxSteps: steps(),
            maxStakeMinor: money(d.maxStake, field('maxStake'), { optional: true }),
            maxCycleExposureMinor: money(d.maxExposure, field('maxExposure'), { optional: true }),
          },
        };
        break;
      case 'martingale':
        config = {
          ...common,
          mode: 'martingale',
          baseStakeMinor: base,
          multiplierX100: multiplier(),
          limits: {
            maxSteps: steps(),
            maxStakeMinor: money(d.maxStake, field('maxStake'), { optional: true }),
            maxCycleExposureMinor: required(d.maxExposure, 'maxExposure'),
          },
        };
        break;
      case 'capped_martingale':
        config = {
          ...common,
          mode: 'capped_martingale',
          baseStakeMinor: base,
          multiplierX100: multiplier(),
          limits: {
            maxSteps: steps(),
            maxStakeMinor: required(d.maxStake, 'maxStake'),
            maxCycleExposureMinor: money(d.maxExposure, field('maxExposure'), { optional: true }),
          },
        };
        break;
      case 'custom': {
        const parts = d.sequence
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t !== '');
        const stakes = parts.map((t) => parseMajorAmountToMinor(t, draft.currency));
        if (parts.length === 0 || parts.length > MAX_CUSTOM_SEQUENCE_LENGTH) {
          errors[field('sequence')] =
            `Enter 1–${MAX_CUSTOM_SEQUENCE_LENGTH} stakes separated by commas, starting with the leg's stake.`;
        } else if (stakes.some((v) => v === null || v <= 0)) {
          errors[field('sequence')] =
            'Each stake must be an amount above zero, such as 500 or 500.50.';
        } else if (stakes[0] !== base) {
          errors[field('sequence')] = "The sequence must start with the leg's stake.";
        }
        config = {
          ...common,
          mode: 'custom',
          stakesMinor: stakes,
          afterFinalStep: 'stop',
          limits: {
            maxStakeMinor: money(d.maxStake, field('maxStake'), { optional: true }),
            maxCycleExposureMinor: money(d.maxExposure, field('maxExposure'), { optional: true }),
          },
        };
        break;
      }
    }
    if (Object.keys(errors).length > before) continue;
    const parsed = progressionConfigSchema.safeParse(config);
    if (!parsed.success) {
      errors[`leg${key}-mode`] = parsed.error.issues[0]?.message ?? 'Invalid progression.';
      continue;
    }
    plan.legs[key] = parsed.data as ProgressionConfig;
  }
  return plan.legs.A === null && plan.legs.B === null ? null : plan;
}

/** The dataset part as raw text (dates are validated and normalised by the server). */
export function datasetInput(draft: StrategyDraft, errors: FieldErrors = {}) {
  if (draft.source.trim() === '') errors.source = 'Choose a source.';
  const importId = draft.importId.trim();
  if (importId !== '' && (!POSITIVE_INT.test(importId) || Number(importId) < 1)) {
    errors.importId = 'Enter an import number (a whole number).';
  }
  const opt = (v: string) => (v.trim() === '' ? undefined : v.trim());
  return {
    source: draft.source.trim(),
    importId: opt(importId),
    eventFrom: opt(draft.eventFrom),
    eventTo: opt(draft.eventTo),
  };
}

const SERVER_PATHS: [RegExp, FieldId][] = [
  ...LEG_KEYS.flatMap((k): [RegExp, FieldId][] => [
    [new RegExp(`^staking\\.legs\\.${k}\\.multiplierX100`), `leg${k}-multiplier`],
    [new RegExp(`^staking\\.legs\\.${k}\\.limits\\.maxSteps`), `leg${k}-maxSteps`],
    [new RegExp(`^staking\\.legs\\.${k}\\.limits\\.maxStakeMinor`), `leg${k}-maxStake`],
    [new RegExp(`^staking\\.legs\\.${k}\\.limits\\.maxCycleExposureMinor`), `leg${k}-maxExposure`],
    [new RegExp(`^staking\\.legs\\.${k}\\.stakesMinor`), `leg${k}-sequence`],
    [new RegExp(`^staking\\.legs\\.${k}`), `leg${k}-mode`],
  ]),
  [/^strategy\.legs\.A\.label/, 'legA-label'],
  [/^strategy\.legs\.A\.stakeMinor/, 'legA-stake'],
  [/^strategy\.legs\.A\.cashoutTargetX100/, 'legA-target'],
  [/^strategy\.legs\.B\.label/, 'legB-label'],
  [/^strategy\.legs\.B\.stakeMinor/, 'legB-stake'],
  [/^strategy\.legs\.B\.cashoutTargetX100/, 'legB-target'],
  [/^strategy\.legs$/, 'legs'],
  [/^settings\.startingBankrollMinor/, 'bankroll'],
  [/^settings\.insufficientBankrollPolicy/, 'policy'],
  [/^settings\.risk\.stopBelowBankrollMinor/, 'stopBelow'],
  [/^settings\.risk\.stopAtOrAboveBankrollMinor/, 'stopAtOrAbove'],
  [/^settings\.risk\.maxDrawdownBps/, 'maxDrawdownPercent'],
  [/^settings\.risk\.maxRounds/, 'maxRounds'],
  [/^(dataset\.)?source/, 'source'],
  [/^(dataset\.)?importId/, 'importId'],
  [/^(dataset\.)?eventFrom/, 'eventFrom'],
  [/^(dataset\.)?eventTo/, 'eventTo'],
];

/** Maps server validation details (dotted paths) onto form fields. */
export function mapServerErrors(details: { path: string; message: string }[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const detail of details) {
    const match = SERVER_PATHS.find(([pattern]) => pattern.test(detail.path));
    if (match && !errors[match[1]]) errors[match[1]] = detail.message;
  }
  return errors;
}
