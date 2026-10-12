import { z } from 'zod';
import { roundIssueSchema } from './rounds.js';

/**
 * Import limits. Fixed in code (not configurable) so the dashboard and API agree.
 * maxBytes is measured on the UTF-8 encoded file content.
 */
export const IMPORT_LIMITS = {
  maxBytes: 2 * 1024 * 1024,
  maxRecords: 10_000,
  maxPreviewRows: 100,
  maxIssues: 200,
  maxNotesLength: 500,
  previewTtlMs: 15 * 60 * 1000,
  maxPendingPreviews: 5,
} as const;

export const importFormatSchema = z.enum(['csv', 'json']);
export type ImportFormat = z.infer<typeof importFormatSchema>;

export const IMPORT_STATUSES = [
  'pending',
  'completed',
  'completed_with_rejections',
  'failed',
] as const;
export const importStatusSchema = z.enum(IMPORT_STATUSES);
export type ImportStatus = z.infer<typeof importStatusSchema>;

/** Request shape only; `source` and `content` are validated further by the domain rules. */
export const importPreviewRequestSchema = z
  .object({
    format: importFormatSchema,
    source: z.string(),
    notes: z.string().max(IMPORT_LIMITS.maxNotesLength).nullable().optional(),
    content: z.string(),
  })
  .strict();
export type ImportPreviewRequest = z.infer<typeof importPreviewRequestSchema>;

/**
 * Per-record classification:
 * - new                 valid and not already stored; will be inserted
 * - invalid             failed validation; will not be stored
 * - duplicate_existing  same (source, sourceRoundId) is already stored; skipped, never overwritten
 * - duplicate_in_file   identical repeat of an earlier record in the same file; skipped
 */
export const previewRowStatusSchema = z.enum([
  'new',
  'invalid',
  'duplicate_existing',
  'duplicate_in_file',
]);
export type PreviewRowStatus = z.infer<typeof previewRowStatusSchema>;

export const previewRowSchema = z.object({
  recordNumber: z.number().int(),
  /** CSV only: the line on which the record ends (1-based, header is line 1). */
  line: z.number().int().nullable(),
  status: previewRowStatusSchema,
  multiplierX100: z.number().int().nullable(),
  sourceRoundId: z.string().nullable(),
  eventAt: z.string().nullable(),
  issues: z.array(roundIssueSchema),
  warnings: z.array(roundIssueSchema),
});
export type PreviewRow = z.infer<typeof previewRowSchema>;

export const previewIssueSchema = roundIssueSchema.extend({
  recordNumber: z.number().int(),
  line: z.number().int().nullable(),
  severity: z.enum(['error', 'warning']),
});
export type PreviewIssue = z.infer<typeof previewIssueSchema>;

export const importCountsSchema = z.object({
  total: z.number().int(),
  new: z.number().int(),
  invalid: z.number().int(),
  duplicateExisting: z.number().int(),
  duplicateInFile: z.number().int(),
  /** Warnings only: records without a sourceRoundId matching a stored round's source, eventAt and multiplier. */
  possibleDuplicates: z.number().int(),
});
export type ImportCounts = z.infer<typeof importCountsSchema>;

export const importPreviewResponseSchema = z.object({
  previewId: z.string(),
  expiresAt: z.string(),
  format: importFormatSchema,
  source: z.string(),
  notes: z.string().nullable(),
  contentSha256: z.string(),
  alreadyImported: z.object({ importId: z.number().int(), importedAt: z.string() }).nullable(),
  counts: importCountsSchema,
  rows: z.array(previewRowSchema),
  rowsTruncated: z.boolean(),
  issues: z.array(previewIssueSchema),
  issuesTruncated: z.boolean(),
});
export type ImportPreviewResponse = z.infer<typeof importPreviewResponseSchema>;

export const importDtoSchema = z.object({
  id: z.number().int(),
  source: z.string(),
  notes: z.string().nullable(),
  sourceKind: z.enum(['manual_entry', 'file_import']),
  format: importFormatSchema.nullable(),
  status: importStatusSchema,
  recordsTotal: z.number().int(),
  recordsAccepted: z.number().int(),
  recordsRejected: z.number().int(),
  recordsDuplicate: z.number().int(),
  contentSha256: z.string().nullable(),
  errorSummary: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  importedAt: z.string(),
});
export type ImportDto = z.infer<typeof importDtoSchema>;

export const importConfirmResponseSchema = z.object({
  import: importDtoSchema,
  counts: importCountsSchema,
});
export type ImportConfirmResponse = z.infer<typeof importConfirmResponseSchema>;

export const importsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).max(10_000_000).default(0),
  })
  .strict();
export type ImportsQuery = z.infer<typeof importsQuerySchema>;

export const importsListResponseSchema = z.object({
  items: z.array(importDtoSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});
export type ImportsListResponse = z.infer<typeof importsListResponseSchema>;

export const previewIdSchema = z.uuid();

export const importConfirmRequestSchema = z.object({ previewId: previewIdSchema }).strict();
export type ImportConfirmRequest = z.infer<typeof importConfirmRequestSchema>;
