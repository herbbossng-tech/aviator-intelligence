import { randomUUID } from 'node:crypto';
import { IMPORT_LIMITS, type ImportFormat } from '@aviator/shared';
import type { FileClassifiedRecord } from './classify.js';

/**
 * Server-side record of what was previewed. Confirmation uses ONLY this stored data,
 * never record data or counts sent back by the client. Previews are single-use,
 * expire after IMPORT_LIMITS.previewTtlMs, are capped in number, and live in memory
 * (they do not survive an API restart).
 */
export interface StoredPreview {
  id: string;
  format: ImportFormat;
  source: string;
  notes: string | null;
  contentSha256: string;
  records: FileClassifiedRecord[];
  createdAt: number;
  expiresAt: number;
}

export class PreviewStore {
  private readonly previews = new Map<string, StoredPreview>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = IMPORT_LIMITS.previewTtlMs,
    private readonly maxEntries: number = IMPORT_LIMITS.maxPendingPreviews,
  ) {}

  create(input: Omit<StoredPreview, 'id' | 'createdAt' | 'expiresAt'>): StoredPreview {
    this.prune();
    while (this.previews.size >= this.maxEntries) {
      const oldest = this.previews.keys().next().value;
      if (oldest === undefined) break;
      this.previews.delete(oldest);
    }
    const createdAt = this.now();
    const preview: StoredPreview = {
      ...input,
      id: randomUUID(),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
    this.previews.set(preview.id, preview);
    return preview;
  }

  /** Removes and returns a live preview, so a preview can be confirmed at most once. */
  take(id: string): StoredPreview | null {
    this.prune();
    const preview = this.previews.get(id) ?? null;
    this.previews.delete(id);
    return preview;
  }

  discard(id: string): boolean {
    return this.previews.delete(id);
  }

  get size(): number {
    this.prune();
    return this.previews.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [id, preview] of this.previews) {
      if (preview.expiresAt <= now) this.previews.delete(id);
    }
  }
}
