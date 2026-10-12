import { Router } from 'express';
import {
  ANALYTICS_METHOD,
  analyticsQuerySchema,
  computeAnalytics,
  DEFAULT_THRESHOLDS_X100,
  MAX_ANALYTICS_ROUNDS,
  type AnalyticsResponse,
} from '@aviator/shared';
import type { Db } from '../../db/connection.js';
import {
  analyticsFilter,
  countSyntheticMatches,
  countWithoutEventTime,
  getDatasetCoverage,
  getMultiplierFrequencies,
} from '../../db/repositories/analytics.js';
import { HttpError } from '../errors.js';

/**
 * GET /api/analytics: descriptive statistics over the stored rounds matching the filters.
 * Read-only. The same data and filters always produce the same response.
 */
export function analyticsRouter(db: Db): Router {
  const router = Router();

  router.get('/analytics', (req, res) => {
    const query = analyticsQuerySchema.parse(req.query);
    const filter = analyticsFilter(query);
    // One read transaction so every count below describes the same snapshot of the data.
    const snapshot = db.transaction(() => {
      const coverage = getDatasetCoverage(db, filter);
      if (coverage.rounds > MAX_ANALYTICS_ROUNDS) return { coverage, tooLarge: true as const };
      return {
        coverage,
        tooLarge: false as const,
        frequencies: getMultiplierFrequencies(db, filter),
        synthetic: countSyntheticMatches(db, filter),
        undated:
          query.eventFrom !== undefined || query.eventTo !== undefined
            ? countWithoutEventTime(db, filter)
            : 0,
      };
    })();
    const { coverage } = snapshot;
    if (snapshot.tooLarge) {
      throw new HttpError(
        422,
        'dataset_too_large',
        `The selection contains ${coverage.rounds} rounds; analytics supports up to ${MAX_ANALYTICS_ROUNDS}. Narrow the filters.`,
      );
    }
    const { frequencies, synthetic, undated } = snapshot;
    const result = computeAnalytics(frequencies, {
      thresholdsX100: query.thresholds ?? DEFAULT_THRESHOLDS_X100,
    });

    const exclusions: AnalyticsResponse['dataset']['exclusions'] = [];
    if (synthetic > 0) {
      exclusions.push({
        reason: 'synthetic_test_fixture',
        count: synthetic,
        description: 'Rows flagged as synthetic test fixtures are never included in analytics.',
      });
    }
    if (undated > 0) {
      exclusions.push({
        reason: 'no_event_time_with_date_filter',
        count: undated,
        description:
          'Rounds without an event time cannot be placed in the selected date range, so they are excluded.',
      });
    }

    const response: AnalyticsResponse = {
      dataset: {
        filters: {
          source: query.source ?? null,
          importId: query.importId ?? null,
          minMultiplierX100: query.minMultiplier ?? null,
          maxMultiplierX100: query.maxMultiplier ?? null,
          eventFrom: query.eventFrom ?? null,
          eventTo: query.eventTo ?? null,
        },
        roundsIncluded: coverage.rounds,
        distinctSources: coverage.distinctSources,
        eventTime: {
          withEventAt: coverage.withEventAt,
          withoutEventAt: coverage.rounds - coverage.withEventAt,
          earliestEventAt: coverage.earliestEventAt,
          latestEventAt: coverage.latestEventAt,
        },
        exclusions,
      },
      ...result,
      method: ANALYTICS_METHOD,
    };
    res.json(response);
  });

  return router;
}
