/**
 * File-level import problems (the whole file is rejected before any record is
 * classified). Each maps to an API error code and HTTP status.
 */
export const IMPORT_FILE_ERROR_STATUS = {
  file_too_large: 413,
  empty_file: 422,
  invalid_encoding: 422,
  invalid_csv: 422,
  invalid_header: 422,
  invalid_json: 422,
  too_many_records: 422,
  invalid_source: 422,
} as const;

export type ImportFileErrorCode = keyof typeof IMPORT_FILE_ERROR_STATUS;

export class ImportFileError extends Error {
  constructor(
    public readonly code: ImportFileErrorCode,
    message: string,
    public readonly details?: { line?: number },
  ) {
    super(message);
    this.name = 'ImportFileError';
  }
}
