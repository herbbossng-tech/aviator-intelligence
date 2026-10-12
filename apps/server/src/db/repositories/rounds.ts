import type { RoundDto } from '@aviator/shared';
import type { Db } from '../connection.js';

interface RoundRow {
  id: number;
  multiplier_x100: number;
  source: string;
  source_round_id: string | null;
  observed_at: string;
  event_at: string | null;
  created_at: string;
}

function toDto(row: RoundRow): RoundDto {
  return {
    id: row.id,
    multiplierX100: row.multiplier_x100,
    source: row.source,
    sourceRoundId: row.source_round_id,
    observedAt: row.observed_at,
    eventAt: row.event_at,
    createdAt: row.created_at,
  };
}

/** Synthetic rows (test fixtures) are always excluded from what the dashboard reads. */
export function listRounds(
  db: Db,
  limit: number,
  offset: number,
): { items: RoundDto[]; total: number } {
  const rows = db
    .prepare(
      `SELECT id, multiplier_x100, source, source_round_id, observed_at, event_at, created_at
         FROM rounds
        WHERE is_synthetic = 0
        ORDER BY observed_at DESC, id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as RoundRow[];
  const { total } = db
    .prepare('SELECT COUNT(*) AS total FROM rounds WHERE is_synthetic = 0')
    .get() as {
    total: number;
  };
  return { items: rows.map(toDto), total };
}

export interface NewRound {
  multiplierX100: number;
  source: string;
  sourceRoundId: string | null;
  observedAt: string;
  eventAt: string | null;
  importId: number | null;
  isSynthetic: boolean;
}

/** Low-level insert; callers are responsible for validating input with the shared schemas. */
export function insertRound(db: Db, round: NewRound): number {
  const result = db
    .prepare(
      `INSERT INTO rounds (multiplier_x100, source, source_round_id, observed_at, event_at, import_id, is_synthetic)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      round.multiplierX100,
      round.source,
      round.sourceRoundId,
      round.observedAt,
      round.eventAt,
      round.importId,
      round.isSynthetic ? 1 : 0,
    );
  return Number(result.lastInsertRowid);
}
