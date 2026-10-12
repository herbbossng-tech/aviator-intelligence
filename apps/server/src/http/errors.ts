import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { ApiError } from '@aviator/shared';

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
    if (err instanceof ZodError) {
      res.status(400).json(
        body(
          'validation_error',
          'Request validation failed',
          err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        ),
      );
      return;
    }
    // body-parser errors (malformed JSON, payload too large) carry a numeric status.
    if (
      typeof err === 'object' &&
      err !== null &&
      'status' in err &&
      typeof err.status === 'number'
    ) {
      const status = err.status >= 400 && err.status < 500 ? err.status : 400;
      res.status(status).json(body('bad_request', 'Malformed or oversized request body'));
      return;
    }
    log('Unhandled API error', err);
    res.status(500).json(body('internal_error', 'An unexpected error occurred'));
  };
}
