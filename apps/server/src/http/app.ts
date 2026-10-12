import express, { type Express } from 'express';
import { LOOPBACK_HOSTS, type AppConfig } from '../config/env.js';
import type { Db } from '../db/connection.js';
import { PreviewStore } from '../imports/previewStore.js';
import { createErrorHandler, notFoundHandler } from './errors.js';
import { loopbackHostGuard } from './hostGuard.js';
import { analyticsRouter } from './routes/analytics.js';
import { dataRouter } from './routes/data.js';
import { importsRouter } from './routes/imports.js';
import { roundsRouter } from './routes/rounds.js';
import { systemRouter } from './routes/system.js';

export interface AppDependencies {
  db: Db;
  config: AppConfig;
  log?: (message: string, error: unknown) => void;
  previewStore?: PreviewStore;
}

/**
 * Body limits: 100 kB for every route except import preview, which accepts file
 * content up to IMPORT_LIMITS.maxBytes (checked separately on the UTF-8 byte length).
 * 5 MB leaves room for JSON string escaping of a 2 MiB file.
 */
const PREVIEW_BODY_LIMIT = '5mb';
const DEFAULT_BODY_LIMIT = '100kb';

export function createApp({
  db,
  config,
  log = console.error,
  previewStore = new PreviewStore(),
}: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  // When bound to loopback, refuse requests addressed to any other host name (DNS rebinding).
  // With AVIATOR_ALLOW_REMOTE_BIND=true and a non-loopback API_HOST the operator has opted out.
  if (LOOPBACK_HOSTS.has(config.host)) app.use(loopbackHostGuard);
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api/imports/preview', express.json({ limit: PREVIEW_BODY_LIMIT }));
  app.use(express.json({ limit: DEFAULT_BODY_LIMIT }));

  app.use('/api', systemRouter(db, config));
  app.use('/api', dataRouter(db, config));
  app.use('/api', roundsRouter(db, log));
  app.use('/api', importsRouter(db, previewStore, log));
  app.use('/api', analyticsRouter(db));

  app.use(notFoundHandler);
  app.use(createErrorHandler(log));
  return app;
}
