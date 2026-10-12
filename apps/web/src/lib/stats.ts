/** Display helpers for analytics values. Formatting only; no statistics are computed here. */

export function formatPercent(proportion: number | null, digits = 1): string {
  return proportion === null ? '—' : `${(proportion * 100).toFixed(digits)}%`;
}

export function formatInterval(ci: { lower: number; upper: number } | null): string {
  return ci === null ? '—' : `${formatPercent(ci.lower)} – ${formatPercent(ci.upper)}`;
}

/** The mean is fractional in x100 units; show it to 0.01x and say so where it is shown. */
export function formatMeanX100(meanX100: number): string {
  return `${(meanX100 / 100).toFixed(2)}x`;
}

export function quantileLabel(levelBps: number): string {
  return `p${levelBps / 100}`;
}
