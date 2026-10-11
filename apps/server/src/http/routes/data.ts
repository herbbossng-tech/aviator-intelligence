import { Router } from 'express';
import type { AppConfig } from '../../config/env.js';
import type { Db } from '../../db/connection.js';
import { getOverview } from '../../db/repositories/overview.js';

export function dataRouter(db: Db, config: AppConfig): Router {
  const router = Router();

  router.get('/overview', (_req, res) => {
    res.json(getOverview(db, config.currency));
  });

  return router;
}
