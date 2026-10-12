import { Router } from 'express';
import {
  importConfirmRequestSchema,
  importPreviewRequestSchema,
  importsQuerySchema,
  previewIdSchema,
  type ImportsListResponse,
} from '@aviator/shared';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { getImport, listImports } from '../../db/repositories/imports.js';
import type { PreviewStore } from '../../imports/previewStore.js';
import { confirmImport, previewImport } from '../../imports/service.js';
import { HttpError } from '../errors.js';

const importIdParamSchema = z.coerce.number().int().positive();

export function importsRouter(
  db: Db,
  store: PreviewStore,
  log: (message: string, error: unknown) => void,
): Router {
  const router = Router();

  /** Validate + preview. Parses the file and compares it with stored data. Writes nothing. */
  router.post('/imports/preview', (req, res) => {
    const request = importPreviewRequestSchema.parse(req.body ?? {});
    res.json(previewImport(db, store, request, new Date()));
  });

  /** Discard a pending preview (e.g. the user cancelled). */
  router.delete('/imports/previews/:previewId', (req, res) => {
    const previewId = previewIdSchema.parse(req.params.previewId);
    store.discard(previewId);
    res.status(204).end();
  });

  /** Confirm a stored preview. The client sends only the preview ID. */
  router.post('/imports', (req, res) => {
    const { previewId } = importConfirmRequestSchema.parse(req.body ?? {});
    res.status(201).json(confirmImport(db, store, previewId, { now: new Date(), log }));
  });

  router.get('/imports', (req, res) => {
    const query = importsQuerySchema.parse(req.query);
    const { items, total } = listImports(db, query.limit, query.offset);
    const response: ImportsListResponse = {
      items,
      total,
      limit: query.limit,
      offset: query.offset,
    };
    res.json(response);
  });

  router.get('/imports/:importId', (req, res) => {
    const id = importIdParamSchema.parse(req.params.importId);
    const item = getImport(db, id);
    if (!item) throw new HttpError(404, 'not_found', `Import ${id} does not exist`);
    res.json(item);
  });

  return router;
}
