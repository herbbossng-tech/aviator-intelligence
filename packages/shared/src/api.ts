import { z } from 'zod';
import { currencyCodeSchema } from './money.js';
import { parseMultiplierInput, MAX_SOURCE_LENGTH } from './rounds.js';

/** Contracts for the local HTTP API, shared by the server and the dashboard. */

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.literal('aviator-intelligence-api'),
  version: z.string(),
  timestamp: z.string(),
  database: z.object({
    status: z.enum(['ok', 'error']),
    schemaVersion: z.number().int().nullable(),
  }),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const metaResponseSchema = z.object({
  name: z.literal('Aviator Intelligence'),
  version: z.string(),
  mode: z.literal('research_simulation'),
  currency: currencyCodeSchema,
  liveObservation: z.object({ status: z.literal('not_connected'), note: z.string() }),
  realMoneyExecution: z.literal('not_supported'),
});
export type MetaResponse = z.infer<typeof metaResponseSchema>;

export const roundDtoSchema = z.object({
  id: z.number().int(),
  multiplierX100: z.number().int(),
  source: z.string(),
  sourceRoundId: z.string().nullable(),
  observedAt: z.string(),
  eventAt: z.string().nullable(),
  /** Null for manually entered rounds. */
  importId: z.number().int().nullable(),
  createdAt: z.string(),
});
export type RoundDto = z.infer<typeof roundDtoSchema>;

/** Optional multiplier filter given as decimal text (same rules as round input), parsed to x100. */
const multiplierFilterSchema = z
  .string()
  .transform((text, ctx) => {
    const parsed = parseMultiplierInput(text);
    if (!parsed.ok) {
      ctx.addIssue({ code: 'custom', message: parsed.issue.message });
      return z.NEVER;
    }
    return parsed.value;
  })
  .optional();

export const ROUND_SORTS = ['recorded_desc', 'event_desc', 'event_asc'] as const;

export const roundsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(10_000_000).default(0),
    /** Exact source label. */
    source: z.string().trim().min(1).max(MAX_SOURCE_LENGTH).optional(),
    /** Case-insensitive substring of sourceRoundId. */
    q: z.string().trim().min(1).max(64).optional(),
    importId: z.coerce.number().int().positive().optional(),
    minMultiplier: multiplierFilterSchema,
    maxMultiplier: multiplierFilterSchema,
    /** recorded_desc: most recently stored first. event_*: by event time, rounds without one last. */
    sort: z.enum(ROUND_SORTS).default('recorded_desc'),
  })
  .strict()
  .refine(
    (q) =>
      q.minMultiplier === undefined ||
      q.maxMultiplier === undefined ||
      q.minMultiplier <= q.maxMultiplier,
    { message: 'minMultiplier must not exceed maxMultiplier', path: ['minMultiplier'] },
  );
export type RoundsQuery = z.infer<typeof roundsQuerySchema>;

export const roundsListResponseSchema = z.object({
  items: z.array(roundDtoSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});
export type RoundsListResponse = z.infer<typeof roundsListResponseSchema>;

/** Shape of POST /api/rounds. Field values are validated by validateRoundRecord + parseSourceLabelInput. */
export const manualRoundRequestSchema = z
  .object({
    source: z.unknown(),
    multiplier: z.unknown(),
    sourceRoundId: z.unknown().optional(),
    eventAt: z.unknown().optional(),
    /** Set after the user confirms a possible-duplicate warning. */
    allowPossibleDuplicate: z.boolean().optional(),
  })
  .strict();
export type ManualRoundRequest = z.infer<typeof manualRoundRequestSchema>;

export const roundSourcesResponseSchema = z.object({
  items: z.array(z.object({ source: z.string(), rounds: z.number().int() })),
});
export type RoundSourcesResponse = z.infer<typeof roundSourcesResponseSchema>;

export const overviewResponseSchema = z.object({
  currency: currencyCodeSchema,
  rounds: z.object({
    total: z.number().int(),
    distinctSources: z.number().int(),
    latestObservedAt: z.string().nullable(),
  }),
  imports: z.object({
    total: z.number().int(),
    failed: z.number().int(),
    recordsAccepted: z.number().int(),
    recordsRejected: z.number().int(),
    recordsDuplicate: z.number().int(),
  }),
  strategies: z.object({ total: z.number().int() }),
  simulations: z.object({ total: z.number().int(), completed: z.number().int() }),
  /** Null until at least one simulation run has actually completed. */
  latestVirtualBankroll: z
    .object({
      simulationRunId: z.number().int(),
      currency: currencyCodeSchema,
      startingBankrollMinor: z.number().int(),
      endingBankrollMinor: z.number().int(),
      completedAt: z.string(),
    })
    .nullable(),
});
export type OverviewResponse = z.infer<typeof overviewResponseSchema>;

export const manualRoundResponseSchema = z.object({ round: roundDtoSchema });
export type ManualRoundResponse = z.infer<typeof manualRoundResponseSchema>;

/** Error detail item used by validation_error responses (both schema and domain validation). */
export const validationDetailSchema = z.object({
  path: z.string(),
  message: z.string(),
  code: z.string().optional(),
});
export type ValidationDetail = z.infer<typeof validationDetailSchema>;
