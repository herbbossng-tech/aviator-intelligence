import { Router } from 'express';
import type { HealthResponse, MetaResponse } from '@aviator/shared';
import type { AppConfig } from '../../config/env.js';
import type { Db } from '../../db/connection.js';
import { getSchemaVersion } from '../../db/migrate.js';
import { APP_VERSION } from '../../version.js';

export function systemRouter(db: Db, config: AppConfig): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    let database: HealthResponse['database'];
    try {
      db.prepare('SELECT 1').get();
      database = { status: 'ok', schemaVersion: getSchemaVersion(db) };
    } catch {
      database = { status: 'error', schemaVersion: null };
    }
    const response: HealthResponse = {
      status: database.status === 'ok' ? 'ok' : 'degraded',
      service: 'aviator-intelligence-api',
      version: APP_VERSION,
      timestamp: new Date().toISOString(),
      database,
    };
    res.status(response.status === 'ok' ? 200 : 503).json(response);
  });

  router.get('/meta', (_req, res) => {
    const response: MetaResponse = {
      name: 'Aviator Intelligence',
      version: APP_VERSION,
      mode: 'research_simulation',
      currency: config.currency,
      liveObservation: {
        status: 'not_connected',
        note: 'No live data source is implemented. Live observation requires a separate review of platform terms and authorised data access.',
      },
      realMoneyExecution: 'not_supported',
    };
    res.json(response);
  });

  return router;
}
