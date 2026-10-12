import type { z } from 'zod';
import {
  analyticsResponseSchema,
  apiErrorSchema,
  healthResponseSchema,
  importConfirmResponseSchema,
  importDtoSchema,
  importPreviewResponseSchema,
  importsListResponseSchema,
  manualRoundResponseSchema,
  metaResponseSchema,
  overviewResponseSchema,
  roundSourcesResponseSchema,
  roundsListResponseSchema,
  validationDetailSchema,
  type ImportFormat,
  type ValidationDetail,
} from '@aviator/shared';

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly code: string | null = null,
    public readonly details: unknown = undefined,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  /** Field-level validation details, when the server returned them. */
  get fieldErrors(): ValidationDetail[] {
    const parsed = validationDetailSchema.array().safeParse(this.details);
    return parsed.success ? parsed.data : [];
  }
}

/** Calls a local API path and validates the response shape before the UI uses it. */
async function request<S extends z.ZodType>(
  path: string,
  schema: S | null,
  init: RequestInit & { signal?: AbortSignal | undefined } = {},
): Promise<z.infer<S>> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiRequestError(
      'The local API is not reachable. Is the server running (npm run dev)?',
      null,
    );
  }
  const body: unknown = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const parsedError = apiErrorSchema.safeParse(body);
    if (parsedError.success) {
      const { code, message, details } = parsedError.data.error;
      throw new ApiRequestError(message, response.status, code, details);
    }
    throw new ApiRequestError(`Request failed with status ${response.status}`, response.status);
  }
  if (schema === null) return undefined as z.infer<S>;
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiRequestError('The API returned an unexpected response shape', response.status);
  }
  return parsed.data;
}

const getJson = <S extends z.ZodType>(path: string, schema: S, signal?: AbortSignal) =>
  request(path, schema, signal ? { signal } : {});
const postJson = <S extends z.ZodType>(path: string, schema: S, body: unknown) =>
  request(path, schema, { method: 'POST', body: JSON.stringify(body) });

export interface RoundFilters {
  limit: number;
  offset: number;
  source?: string | undefined;
  q?: string | undefined;
  importId?: number | undefined;
  minMultiplier?: string | undefined;
  maxMultiplier?: string | undefined;
  sort?: 'recorded_desc' | 'event_desc' | 'event_asc' | undefined;
}

function toQuery(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  return search.toString();
}

/** Raw text filters for GET /api/analytics; the server parses and validates them. */
export interface AnalyticsFilters {
  source?: string | undefined;
  minMultiplier?: string | undefined;
  maxMultiplier?: string | undefined;
  eventFrom?: string | undefined;
  eventTo?: string | undefined;
  thresholds?: string | undefined;
}

export interface ManualRoundInput {
  source: string;
  multiplier: string;
  sourceRoundId?: string;
  eventAt?: string;
  allowPossibleDuplicate?: boolean;
}

export const api = {
  health: (signal?: AbortSignal) => getJson('/api/health', healthResponseSchema, signal),
  meta: (signal?: AbortSignal) => getJson('/api/meta', metaResponseSchema, signal),
  overview: (signal?: AbortSignal) => getJson('/api/overview', overviewResponseSchema, signal),
  rounds: (filters: RoundFilters, signal?: AbortSignal) =>
    getJson(`/api/rounds?${toQuery(filters)}`, roundsListResponseSchema, signal),
  roundSources: (signal?: AbortSignal) =>
    getJson('/api/rounds/sources', roundSourcesResponseSchema, signal),
  createRound: (input: ManualRoundInput) =>
    postJson('/api/rounds', manualRoundResponseSchema, input),
  previewImport: (input: {
    format: ImportFormat;
    source: string;
    notes: string | null;
    content: string;
  }) => postJson('/api/imports/preview', importPreviewResponseSchema, input),
  confirmImport: (previewId: string) =>
    postJson('/api/imports', importConfirmResponseSchema, { previewId }),
  discardPreview: (previewId: string) =>
    request(`/api/imports/previews/${encodeURIComponent(previewId)}`, null, { method: 'DELETE' }),
  imports: (limit: number, offset: number, signal?: AbortSignal) =>
    getJson(`/api/imports?${toQuery({ limit, offset })}`, importsListResponseSchema, signal),
  importDetail: (id: number, signal?: AbortSignal) =>
    getJson(`/api/imports/${id}`, importDtoSchema, signal),
  analytics: (filters: AnalyticsFilters, signal?: AbortSignal) => {
    const query = toQuery(filters);
    return getJson(`/api/analytics${query ? `?${query}` : ''}`, analyticsResponseSchema, signal);
  },
};
