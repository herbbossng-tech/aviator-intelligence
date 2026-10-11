import { Router } from 'express';
import {
  manualRoundRequestSchema,
  parseSourceLabelInput,
  roundsQuerySchema,
  validateRoundRecord,
  type ManualRoundResponse,
  type RoundIssue,
  type RoundsListResponse,
} from '@aviator/shared';
import type { Db } from '../../db/connection.js';
import {
  findRoundBySourceId,
  getRound,
  hasPossibleDuplicate,
  insertRound,
  listRounds,
  listRoundSources,
} from '../../db/repositories/rounds.js';
import { HttpError, validationError } from '../errors.js';

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

export function roundsRouter(db: Db, log: (message: string, error: unknown) => void): Router {
  const router = Router();

  router.get('/rounds', (req, res) => {
    const query = roundsQuerySchema.parse(req.query);
    const { items, total } = listRounds(db, query);
    const response: RoundsListResponse = { items, total, limit: query.limit, offset: query.offset };
    res.json(response);
  });

  router.get('/rounds/sources', (_req, res) => {
    res.json({ items: listRoundSources(db) });
  });

  /**
   * Manual entry. Uses exactly the same validation and identity rules as file import.
   * Manual rounds have no import row (importId null); their provenance is the source label.
   */
  router.post('/rounds', (req, res) => {
    const body = manualRoundRequestSchema.parse(req.body ?? {});
    const now = new Date();
    const issues: RoundIssue[] = [];
    const source = parseSourceLabelInput(body.source);
    if (!source.ok) issues.push(source.issue);
    const fields: Record<string, unknown> = { multiplier: body.multiplier };
    if (body.sourceRoundId !== undefined) fields.sourceRoundId = body.sourceRoundId;
    if (body.eventAt !== undefined) fields.eventAt = body.eventAt;
    const record = validateRoundRecord(fields, now);
    if (!record.ok) issues.push(...record.issues);
    if (!source.ok || !record.ok) {
      throw validationError(
        issues.map((i) => ({ path: i.field ?? '', message: i.message, code: i.code })),
      );
    }

    const round = record.record;
    const id = (() => {
      try {
        return db.transaction(() => {
          if (round.sourceRoundId !== null) {
            const existing = findRoundBySourceId(db, source.value, round.sourceRoundId);
            if (existing) {
              throw new HttpError(
                409,
                'duplicate_source_id',
                `A round with this source and sourceRoundId already exists (round ${existing.id}); it was not changed.`,
                { roundId: existing.id },
              );
            }
          } else if (
            round.eventAt !== null &&
            body.allowPossibleDuplicate !== true &&
            hasPossibleDuplicate(db, source.value, round.eventAt, round.multiplierX100)
          ) {
            throw new HttpError(
              409,
              'possible_duplicate',
              'A round with the same source, eventAt and multiplier already exists. Add a sourceRoundId, or confirm to save it anyway.',
            );
          }
          return insertRound(db, {
            ...round,
            source: source.value,
            observedAt: now.toISOString(),
            importId: null,
            isSynthetic: false,
          });
        })();
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (isUniqueViolation(error)) {
          throw new HttpError(
            409,
            'duplicate_source_id',
            'A round with this source and sourceRoundId already exists.',
          );
        }
        log('Manual round insert failed', error);
        throw new HttpError(
          500,
          'database_write_failed',
          'The round could not be saved. Nothing was stored.',
        );
      }
    })();

    const stored = getRound(db, id);
    if (!stored) throw new Error('round missing after insert');
    const response: ManualRoundResponse = { round: stored };
    res.status(201).json(response);
  });

  return router;
}
