import { z } from 'zod';

/**
 * Monetary amounts are always stored and calculated as integers in the currency's
 * minor unit (for example kobo for NGN, cents for USD). Floating-point numbers are
 * never used for accounting. All amounts in this project are VIRTUAL (simulated).
 */
export const SUPPORTED_CURRENCIES = {
  NGN: { symbol: '₦', minorUnits: 2 },
  USD: { symbol: '$', minorUnits: 2 },
  GBP: { symbol: '£', minorUnits: 2 },
  EUR: { symbol: '€', minorUnits: 2 },
} as const;

export const currencyCodeSchema = z.enum(['NGN', 'USD', 'GBP', 'EUR']);
export type CurrencyCode = z.infer<typeof currencyCodeSchema>;

/** Upper bound for any single virtual amount, in minor units. Keeps products well inside Number.MAX_SAFE_INTEGER. */
export const MAX_MINOR_AMOUNT = 1_000_000_000_000;

export const minorAmountSchema = z.number().int().min(0).max(MAX_MINOR_AMOUNT);
export const positiveMinorAmountSchema = z.number().int().min(1).max(MAX_MINOR_AMOUNT);

/** Formats an integer minor-unit amount without converting through floating point. */
export function formatMinorAmount(amountMinor: number, currency: CurrencyCode): string {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new RangeError(`Amount must be a safe integer in minor units, received ${amountMinor}`);
  }
  const { symbol, minorUnits } = SUPPORTED_CURRENCIES[currency];
  const divisor = 10 ** minorUnits;
  const sign = amountMinor < 0 ? '-' : '';
  const absolute = Math.abs(amountMinor);
  const major = Math.floor(absolute / divisor)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const minor = (absolute % divisor).toString().padStart(minorUnits, '0');
  return `${sign}${symbol}${major}.${minor}`;
}

/**
 * Parses a major-unit amount typed by a user ("500", "500.5", "1,250.00") into exact integer
 * minor units without floating point. Rejects negatives, exponents, more decimals than the
 * currency has, and values above MAX_MINOR_AMOUNT. Returns null for invalid input.
 */
export function parseMajorAmountToMinor(text: string, currency: CurrencyCode): number | null {
  const { minorUnits } = SUPPORTED_CURRENCIES[currency];
  const cleaned = text.trim().replace(/,(?=\d{3}(\D|$))/g, '');
  const match = new RegExp(`^(\\d{1,13})(?:\\.(\\d{1,${minorUnits}}))?$`).exec(cleaned);
  if (!match) return null;
  const minor =
    Number(match[1]) * 10 ** minorUnits + Number((match[2] ?? '').padEnd(minorUnits, '0') || '0');
  return Number.isSafeInteger(minor) && minor <= MAX_MINOR_AMOUNT ? minor : null;
}
