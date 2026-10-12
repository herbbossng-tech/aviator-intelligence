import type { AnalyticsQuery, MultiplierFrequency } from '@aviator/shared';
import type { Db } from '../connection.js';
import { roundFilterSql, type RoundFilter } from './rounds.js';

export function analyticsFilter(query: AnalyticsQuery): RoundFilter {
  return {
    source: query.source,
    importId: query.importId,
    minMultiplier: query.minMultiplier,
    maxMultiplier: query.maxMultiplier,
    eventFrom: query.eventFrom,
    eventTo: query.eventTo,
  };
}

/**
 * Exact frequency table of multipliers for the selected (non-synthetic) rounds, ascending.
 * Aggregated in SQLite so only one row per distinct multiplier leaves the database.
 */
export function getMultiplierFrequencies(db: Db, filter: RoundFilter): MultiplierFrequency[] {
  const { where, params } = roundFilterSql(filter);
  return db
    .prepare(
      `SELECT multiplier_x100 AS multiplierX100, COUNT(*) AS count
         FROM rounds WHERE ${where}
        GROUP BY multiplier_x100
        ORDER BY multiplier_x100`,
    )
    .all(...params) as MultiplierFrequency[];
}

export interface DatasetCoverage {
  rounds: number;
  distinctSources: number;
  withEventAt: number;
  earliestEventAt: string | null;
  latestEventAt: string | null;
}

export function getDatasetCoverage(db: Db, filter: RoundFilter): DatasetCoverage {
  const { where, params } = roundFilterSql(filter);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS rounds,
              COUNT(DISTINCT source) AS distinctSources,
              COUNT(event_at) AS withEventAt,
              MIN(event_at) AS earliestEventAt,
              MAX(event_at) AS latestEventAt
         FROM rounds WHERE ${where}`,
    )
    .get(...params) as DatasetCoverage;
  return row;
}

/** Synthetic test-fixture rows that match the other filters (always excluded from analytics). */
export function countSyntheticMatches(db: Db, filter: RoundFilter): number {
  const { where, params } = roundFilterSql(filter, { synthetic: 'only' });
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM rounds WHERE ${where}`).get(...params) as { n: number }
  ).n;
}

/** Rounds matching every non-date filter but lacking an event time, so a date range excludes them. */
export function countWithoutEventTime(db: Db, filter: RoundFilter): number {
  const { where, params } = roundFilterSql({ ...filter, eventFrom: undefined, eventTo: undefined });
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM rounds WHERE ${where} AND event_at IS NULL`)
      .get(...params) as {
      n: number;
    }
  ).n;
}
