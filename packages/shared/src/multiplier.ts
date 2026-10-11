import { z } from 'zod';

/**
 * Multipliers are represented as integers scaled by 100 ("x100"), matching the two
 * decimal places Aviator displays. 2.35x is stored as 235. 1.00x (the minimum possible
 * crash point) is stored as 100. Input with more than two decimal places is rejected
 * rather than silently rounded, so imported data is never altered without notice.
 */
export const MULTIPLIER_SCALE = 100;
export const MIN_ROUND_MULTIPLIER_X100 = 100;
/** Sanity cap (1,000,000.00x) to reject corrupted input; not a claim about the game's real maximum. */
export const MAX_MULTIPLIER_X100 = 100_000_000;

export const roundMultiplierX100Schema = z
  .number()
  .int()
  .min(MIN_ROUND_MULTIPLIER_X100, 'A round multiplier cannot be below 1.00x')
  .max(MAX_MULTIPLIER_X100);

/** A cashout target of 1.00x could never produce a profit, so targets start at 1.01x. */
export const cashoutTargetX100Schema = z
  .number()
  .int()
  .min(MIN_ROUND_MULTIPLIER_X100 + 1, 'A cashout target must be at least 1.01x')
  .max(MAX_MULTIPLIER_X100);

const MULTIPLIER_TEXT = /^(\d{1,9})(?:\.(\d{1,2}))?x?$/i;

/** Parses text such as "2", "2.5", "2.35" or "2.35x" into an x100 integer. Throws on invalid input. */
export function parseMultiplierX100(text: string): number {
  const match = MULTIPLIER_TEXT.exec(text.trim());
  if (!match) {
    throw new Error(`Invalid multiplier "${text}": expected a number with at most two decimals`);
  }
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? '0').padEnd(2, '0'));
  const value = whole * MULTIPLIER_SCALE + fraction;
  if (value < MIN_ROUND_MULTIPLIER_X100 || value > MAX_MULTIPLIER_X100) {
    throw new Error(`Invalid multiplier "${text}": outside the accepted range`);
  }
  return value;
}

export function formatMultiplierX100(valueX100: number): string {
  if (!Number.isSafeInteger(valueX100) || valueX100 < 0) {
    throw new RangeError(
      `Multiplier must be a non-negative integer x100 value, received ${valueX100}`,
    );
  }
  const whole = Math.floor(valueX100 / MULTIPLIER_SCALE);
  const fraction = (valueX100 % MULTIPLIER_SCALE).toString().padStart(2, '0');
  return `${whole}.${fraction}x`;
}
