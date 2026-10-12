import type { z } from 'zod';
import {
  apiErrorSchema,
  healthResponseSchema,
  metaResponseSchema,
  overviewResponseSchema,
  roundsListResponseSchema,
} from '@aviator/shared';

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/** Fetches a local API path and validates the response shape before the UI uses it. */
async function getJson<S extends z.ZodType>(
  path: string,
  schema: S,
  signal?: AbortSignal,
): Promise<z.infer<S>> {
  let response: Response;
  try {
    response = await fetch(path, {
      headers: { Accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiRequestError(
      'The local API is not reachable. Is the server running (npm run dev)?',
      null,
    );
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsedError = apiErrorSchema.safeParse(body);
    throw new ApiRequestError(
      parsedError.success
        ? parsedError.data.error.message
        : `Request failed with status ${response.status}`,
      response.status,
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiRequestError('The API returned an unexpected response shape', response.status);
  }
  return parsed.data;
}

export const api = {
  health: (signal?: AbortSignal) => getJson('/api/health', healthResponseSchema, signal),
  meta: (signal?: AbortSignal) => getJson('/api/meta', metaResponseSchema, signal),
  overview: (signal?: AbortSignal) => getJson('/api/overview', overviewResponseSchema, signal),
  rounds: (limit: number, offset: number, signal?: AbortSignal) =>
    getJson(`/api/rounds?limit=${limit}&offset=${offset}`, roundsListResponseSchema, signal),
};
