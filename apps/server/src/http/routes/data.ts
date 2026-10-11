import { Router } from 'express';
import { roundsQuerySchema, type RoundsListResponse } from '@aviator/shared';
import type { AppConfig } from '../../config/env.js';
import type { Db } from '../../db/connection.js';
import { getOverview } from '../../db/repositories/overview.js';
import { listRounds } from '../../db/repositories/rounds.js';

/** Read-only data endpoints. No write endpoints exist in this pass. */
export function dataRouter(db: Db, config: AppConfig): Router {
  const router = Router();

  router.get('/overview', (_req, res) => {
    res.json(getOverview(db, config.currency));
  });

  router.get('/rounds', (req, res) => {
    const query = roundsQuerySchema.parse(req.query);
    const { items, total } = listRounds(db, query.limit, query.offset);
    const response: RoundsListResponse = { items, total, limit: query.limit, offset: query.offset };
    res.json(response);
  });

  return router;
}
