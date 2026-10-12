import {
  LEG_KEYS,
  parseMajorAmountToMinor,
  parseMultiplierX100,
  SAMPLE_TWO_LEG_CONFIG,
  type BacktestRequestInput,
  type CurrencyCode,
  type LegKey,
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

export interface StrategyDraft {
  currency: CurrencyCode;
  legs: Record<LegKey, LegDraft>;
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
    },
  };
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
