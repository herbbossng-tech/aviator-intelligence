import express, { type Express } from 'express';
import type { AppConfig } from '../config/env.js';
import type { Db } from '../db/connection.js';
import { createErrorHandler, notFoundHandler } from './errors.js';
import { dataRouter } from './routes/data.js';
import { systemRouter } from './routes/system.js';

export interface AppDependencies {
  db: Db;
  config: AppConfig;
  log?: (message: string, error: unknown) => void;
}

export function createApp({ db, config, log = console.error }: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '100kb' }));

  app.use('/api', systemRouter(db, config));
  app.use('/api', dataRouter(db, config));

  app.use(notFoundHandler);
  app.use(createErrorHandler(log));
  return app;
}
