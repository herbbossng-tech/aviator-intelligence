import type { RoundDto, RoundsQuery } from '@aviator/shared';
import type { Db } from '../connection.js';

interface RoundRow {
  id: number;
  multiplier_x100: number;
  source: string;
  source_round_id: string | null;
  observed_at: string;
  event_at: string | null;
  import_id: number | null;
  created_at: string;
}

const ROUND_COLUMNS =
  'id, multiplier_x100, source, source_round_id, observed_at, event_at, import_id, created_at';

function toDto(row: RoundRow): RoundDto {
  return {
    id: row.id,
    multiplierX100: row.multiplier_x100,
    source: row.source,
    sourceRoundId: row.source_round_id,
    observedAt: row.observed_at,
    eventAt: row.event_at,
    importId: row.import_id,
    createdAt: row.created_at,
  };
}

const ORDER_BY: Record<RoundsQuery['sort'], string> = {
  recorded_desc: 'id DESC',
  event_desc: 'event_at IS NULL, event_at DESC, id DESC',
  event_asc: 'event_at IS NULL, event_at ASC, id ASC',
};

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Lists non-synthetic rounds. Filters are combined from fixed SQL fragments; every
 * user-supplied value is bound as a parameter. Synthetic test fixtures are always excluded.
 */
export function listRounds(db: Db, query: RoundsQuery): { items: RoundDto[]; total: number } {
  const where = ['is_synthetic = 0'];
  const params: (string | number)[] = [];
  if (query.source !== undefined) {
    where.push('source = ?');
    params.push(query.source);
  }
  if (query.q !== undefined) {
    where.push("source_round_id LIKE ? ESCAPE '\\' COLLATE NOCASE");
    params.push(`%${escapeLike(query.q)}%`);
  }
  if (query.importId !== undefined) {
    where.push('import_id = ?');
    params.push(query.importId);
  }
  if (query.minMultiplier !== undefined) {
    where.push('multiplier_x100 >= ?');
    params.push(query.minMultiplier);
  }
  if (query.maxMultiplier !== undefined) {
    where.push('multiplier_x100 <= ?');
    params.push(query.maxMultiplier);
  }
  const whereSql = where.join(' AND ');
  const rows = db
    .prepare(
      `SELECT ${ROUND_COLUMNS} FROM rounds WHERE ${whereSql} ORDER BY ${ORDER_BY[query.sort]} LIMIT ? OFFSET ?`,
    )
    .all(...params, query.limit, query.offset) as RoundRow[];
  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM rounds WHERE ${whereSql}`)
    .get(...params) as {
    total: number;
  };
  return { items: rows.map(toDto), total };
}

export function getRound(db: Db, id: number): RoundDto | null {
  const row = db.prepare(`SELECT ${ROUND_COLUMNS} FROM rounds WHERE id = ?`).get(id) as
    RoundRow | undefined;
  return row ? toDto(row) : null;
}

/** Distinct non-synthetic source labels with counts, for filter controls. */
export function listRoundSources(db: Db): { source: string; rounds: number }[] {
  return db
    .prepare(
      `SELECT source, COUNT(*) AS rounds FROM rounds WHERE is_synthetic = 0 GROUP BY source ORDER BY source LIMIT 500`,
    )
    .all() as { source: string; rounds: number }[];
}

/** Identity lookup: (source, source_round_id) mirrors the UNIQUE constraint, so synthetic rows count too. */
export function findRoundBySourceId(
  db: Db,
  source: string,
  sourceRoundId: string,
): { id: number; multiplierX100: number; eventAt: string | null } | null {
  const row = db
    .prepare(
      'SELECT id, multiplier_x100, event_at FROM rounds WHERE source = ? AND source_round_id = ?',
    )
    .get(source, sourceRoundId) as
    { id: number; multiplier_x100: number; event_at: string | null } | undefined;
  return row ? { id: row.id, multiplierX100: row.multiplier_x100, eventAt: row.event_at } : null;
}

/**
 * Heuristic, warning-only check for records WITHOUT a source round ID: is there already a
 * round with the same source, the same normalised event time and the same multiplier?
 */
export function hasPossibleDuplicate(
  db: Db,
  source: string,
  eventAt: string,
  multiplierX100: number,
): boolean {
  return (
    db
      .prepare(
        'SELECT 1 FROM rounds WHERE source = ? AND event_at = ? AND multiplier_x100 = ? LIMIT 1',
      )
      .get(source, eventAt, multiplierX100) !== undefined
  );
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

/** Low-level insert; callers are responsible for validating input with the shared rules. */
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
