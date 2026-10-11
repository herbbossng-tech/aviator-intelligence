/**
 * Round import support (pass 2). Additive only: migration 001 is never edited.
 *
 * - data_imports gains format, notes, duplicate counter, content hash and timing columns.
 * - Counter consistency is enforced by triggers (SQLite cannot add table CHECKs to an
 *   existing table without rebuilding it, which would require disabling foreign keys).
 * - A partial UNIQUE index on content_sha256 makes it impossible to record the same file
 *   as successfully imported twice, even if application checks were bypassed.
 */
export const sql = `
ALTER TABLE data_imports ADD COLUMN format TEXT
  CHECK (format IS NULL OR format IN ('csv', 'json'));
ALTER TABLE data_imports ADD COLUMN notes TEXT
  CHECK (notes IS NULL OR length(notes) <= 500);
ALTER TABLE data_imports ADD COLUMN records_duplicate INTEGER NOT NULL DEFAULT 0
  CHECK (records_duplicate >= 0);
ALTER TABLE data_imports ADD COLUMN content_sha256 TEXT
  CHECK (content_sha256 IS NULL OR (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE data_imports ADD COLUMN started_at TEXT;
ALTER TABLE data_imports ADD COLUMN completed_at TEXT;

CREATE UNIQUE INDEX idx_data_imports_successful_content
  ON data_imports (content_sha256)
  WHERE content_sha256 IS NOT NULL AND status IN ('completed', 'completed_with_rejections');
CREATE INDEX idx_data_imports_imported_at ON data_imports (imported_at);
CREATE INDEX idx_rounds_source_event_at ON rounds (source, event_at);

CREATE TRIGGER data_imports_counters_insert
BEFORE INSERT ON data_imports
WHEN NEW.records_accepted + NEW.records_rejected + NEW.records_duplicate > NEW.records_total
  OR (NEW.status IN ('completed', 'completed_with_rejections')
      AND NEW.records_accepted + NEW.records_rejected + NEW.records_duplicate <> NEW.records_total)
BEGIN
  SELECT RAISE(ABORT, 'data_imports counters are inconsistent with records_total');
END;

CREATE TRIGGER data_imports_counters_update
BEFORE UPDATE ON data_imports
WHEN NEW.records_accepted + NEW.records_rejected + NEW.records_duplicate > NEW.records_total
  OR (NEW.status IN ('completed', 'completed_with_rejections')
      AND NEW.records_accepted + NEW.records_rejected + NEW.records_duplicate <> NEW.records_total)
BEGIN
  SELECT RAISE(ABORT, 'data_imports counters are inconsistent with records_total');
END;
`;
