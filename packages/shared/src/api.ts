import { z } from 'zod';
import { currencyCodeSchema } from './money.js';

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
  createdAt: z.string(),
});
export type RoundDto = z.infer<typeof roundDtoSchema>;

export const roundsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(10_000_000).default(0),
  })
  .strict();
export type RoundsQuery = z.infer<typeof roundsQuerySchema>;

export const roundsListResponseSchema = z.object({
  items: z.array(roundDtoSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});
export type RoundsListResponse = z.infer<typeof roundsListResponseSchema>;

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
