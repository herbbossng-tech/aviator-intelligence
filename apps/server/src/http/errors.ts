import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { ApiError, ValidationDetail } from '@aviator/shared';
import { IMPORT_FILE_ERROR_STATUS, ImportFileError } from '../imports/errors.js';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function validationError(details: ValidationDetail[]): HttpError {
  return new HttpError(400, 'validation_error', 'Request validation failed', details);
}

function body(code: string, message: string, details?: unknown): ApiError {
  return details === undefined
    ? { error: { code, message } }
    : { error: { code, message, details } };
}

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json(body('not_found', `No route for ${req.method} ${req.path}`));
};

/** Consistent JSON errors. Internal error details are logged server-side, never returned. */
export function createErrorHandler(
  log: (message: string, error: unknown) => void,
): ErrorRequestHandler {
  return (err: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.status).json(body(err.code, err.message, err.details));
      return;
    }
    if (err instanceof ImportFileError) {
      res.status(IMPORT_FILE_ERROR_STATUS[err.code]).json(body(err.code, err.message, err.details));
      return;
    }
    if (err instanceof ZodError) {
      const details: ValidationDetail[] = err.issues.slice(0, 50).map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      }));
      res.status(400).json(body('validation_error', 'Request validation failed', details));
      return;
    }
    // body-parser errors carry a numeric status and a type.
    if (
      typeof err === 'object' &&
      err !== null &&
      'status' in err &&
      typeof err.status === 'number'
    ) {
      const type = 'type' in err ? err.type : undefined;
      if (type === 'entity.too.large') {
        res.status(413).json(body('payload_too_large', 'Request body is too large'));
        return;
      }
      if (type === 'entity.parse.failed') {
        res.status(400).json(body('invalid_request_json', 'Request body is not valid JSON'));
        return;
      }
      const status = err.status >= 400 && err.status < 500 ? err.status : 400;
      res.status(status).json(body('bad_request', 'Malformed request'));
      return;
    }
    log('Unhandled API error', err);
    res.status(500).json(body('internal_error', 'An unexpected error occurred'));
  };
}
