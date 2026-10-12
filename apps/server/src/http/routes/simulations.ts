import { Router } from 'express';
import {
  analysisRequestSchema,
  analysesQuerySchema,
  backtestDatasetQuerySchema,
  backtestRequestSchema,
  ledgerQuerySchema,
  MAX_BACKTEST_ROUNDS,
  maxPathsForSample,
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
import { getAnalysis, listAnalyses } from '../../db/repositories/analyses.js';
import { runAndStoreAnalysis } from '../../simulations/analysis.js';
import { runAndStoreBacktest } from '../../simulations/service.js';
import { HttpError } from '../errors.js';

/** Plain decimal ids only: no exponents, hex, signs, spaces or leading zeros. */
const runIdSchema = z
  .string()
  .regex(/^[1-9]\d{0,15}$/)
  .transform(Number)
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));

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

  // Uncertainty analyses (IID bootstrap) of a completed run. Virtual money only.
  router.post('/simulations/:id/analyses', (req, res) => {
    const run = findRun(req.params.id);
    const settings = analysisRequestSchema.parse(req.body);
    res.status(201).json(runAndStoreAnalysis(db, run, settings, { now, maxRounds, log }));
  });

  router.get('/simulations/:id/analyses', (req, res) => {
    const query = analysesQuerySchema.parse(req.query);
    const run = findRun(req.params.id);
    const sampleSize = run.status === 'completed' ? (run.dataset?.roundsEligible ?? null) : null;
    res.json({
      ...listAnalyses(db, run.id, query),
      maxPaths: sampleSize === null ? 0 : maxPathsForSample(sampleSize),
      sampleSize,
    });
  });

  router.get('/simulations/:id/analyses/:analysisId', (req, res) => {
    const run = findRun(req.params.id);
    const parsed = runIdSchema.safeParse(req.params.analysisId);
    const analysis = parsed.success ? getAnalysis(db, run.id, parsed.data) : null;
    if (!analysis) throw new HttpError(404, 'analysis_not_found', 'No such analysis for this run.');
    res.json(analysis);
  });

  return router;
}
