import { Router } from 'express';
import {
  backtestDatasetQuerySchema,
  backtestRequestSchema,
  ledgerQuerySchema,
  MAX_BACKTEST_ROUNDS,
  simulationRunsQuerySchema,
} from '@aviator/shared';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import {
  getDatasetReport,
  getLedgerPage,
  getRun,
  listRuns,
} from '../../db/repositories/simulations.js';
import { runAndStoreBacktest } from '../../simulations/service.js';
import { HttpError } from '../errors.js';

const runIdSchema = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export interface SimulationsRouterOptions {
  log: (message: string, error: unknown) => void;
  maxRounds?: number;
  now?: () => Date;
}

/**
 * Virtual backtests over stored historical rounds. Virtual money only; nothing here
 * contacts any external service or places any bet. Historical rounds are only read.
 */
export function simulationsRouter(
  db: Db,
  { log, maxRounds = MAX_BACKTEST_ROUNDS, now = () => new Date() }: SimulationsRouterOptions,
): Router {
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > MAX_BACKTEST_ROUNDS) {
    throw new RangeError(`maxRounds must be an integer between 1 and ${MAX_BACKTEST_ROUNDS}`);
  }
  const router = Router();

  router.get('/simulations/dataset', (req, res) => {
    const dataset = backtestDatasetQuerySchema.parse(req.query);
    res.json(db.transaction(() => getDatasetReport(db, dataset, maxRounds))());
  });

  router.post('/simulations', (req, res) => {
    const request = backtestRequestSchema.parse(req.body);
    res.status(201).json(runAndStoreBacktest(db, request, { now, maxRounds, log }));
  });

  router.get('/simulations', (req, res) => {
    const query = simulationRunsQuerySchema.parse(req.query);
    res.json({ ...listRuns(db, query), limit: query.limit, offset: query.offset });
  });

  function findRun(idText: unknown) {
    const parsed = runIdSchema.safeParse(idText);
    const run = parsed.success ? getRun(db, parsed.data) : null;
    if (!run) throw new HttpError(404, 'simulation_not_found', 'No such simulation run.');
    return run;
  }

  router.get('/simulations/:id', (req, res) => {
    res.json(findRun(req.params.id));
  });

  router.get('/simulations/:id/ledger', (req, res) => {
    const query = ledgerQuerySchema.parse(req.query);
    const run = findRun(req.params.id);
    res.json(getLedgerPage(db, run, query));
  });

  return router;
}
