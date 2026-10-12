import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  IMPORT_LIMITS,
  parseSourceLabelInput,
  type ImportConfirmResponse,
  type ImportFormat,
  type ImportPreviewResponse,
} from '@aviator/shared';
import { ApiRequestError, api } from '../../api/client';
import { ErrorNotice } from '../../components/ErrorNotice';
import { FormField, inputClass } from '../../components/FormField';
import { Notice } from '../../components/Notice';
import { Panel } from '../../components/Panel';
import { formatCount } from '../../lib/format';
import { ImportPreviewView } from './ImportPreviewView';

type Stage =
  | { kind: 'idle' }
  | { kind: 'previewing' }
  | { kind: 'preview'; preview: ImportPreviewResponse }
  | { kind: 'confirming'; preview: ImportPreviewResponse }
  | { kind: 'done'; result: ImportConfirmResponse };

function formatFromName(name: string): ImportFormat | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.json')) return 'json';
  return null;
}

export function ImportPage() {
  const [file, setFile] = useState<File | null>(null);
  const [format, setFormat] = useState<ImportFormat | ''>('');
  const [source, setSource] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<{ file?: string; format?: string; source?: string }>({});
  const [requestError, setRequestError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const fileInput = useRef<HTMLInputElement>(null);

  const busy = stage.kind === 'previewing' || stage.kind === 'confirming';

  const onFile = (next: File | null) => {
    setFile(next);
    setStage({ kind: 'idle' });
    setRequestError(null);
    const detected = next ? formatFromName(next.name) : null;
    if (detected) setFormat(detected);
  };

  const preview = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setRequestError(null);
    const nextErrors: typeof errors = {};
    if (!file) nextErrors.file = 'Choose a CSV or JSON file';
    else if (file.size > IMPORT_LIMITS.maxBytes)
      nextErrors.file = `File is ${formatCount(file.size)} bytes; the limit is ${formatCount(IMPORT_LIMITS.maxBytes)} bytes`;
    if (!format) nextErrors.format = 'Choose the file format';
    const label = parseSourceLabelInput(source);
    if (!label.ok) nextErrors.source = label.issue.message;
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || !file || !format) return;

    setStage({ kind: 'previewing' });
    try {
      const content = await file.text();
      const result = await api.previewImport({
        format,
        source,
        notes: notes.trim() || null,
        content,
      });
      setStage({ kind: 'preview', preview: result });
    } catch (error) {
      setStage({ kind: 'idle' });
      setRequestError(describeError(error));
    }
  };

  const confirm = async () => {
    if (stage.kind !== 'preview') return;
    const current = stage.preview;
    setStage({ kind: 'confirming', preview: current });
    setRequestError(null);
    try {
      const result = await api.confirmImport(current.previewId);
      setStage({ kind: 'done', result });
    } catch (error) {
      // A failed confirm consumes the preview on the server; the user must validate again.
      setStage({ kind: 'idle' });
      setRequestError(describeError(error));
    }
  };

  const cancel = () => {
    if (stage.kind === 'preview')
      void api.discardPreview(stage.preview.previewId).catch(() => undefined);
    setStage({ kind: 'idle' });
  };

  const startOver = () => {
    setStage({ kind: 'idle' });
    setFile(null);
    setRequestError(null);
    if (fileInput.current) fileInput.current.value = '';
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Panel
          title="Import a file"
          subtitle="Step 1: validate and preview. Nothing is stored until you confirm."
        >
          <form
            noValidate
            onSubmit={(e) => void preview(e)}
            className="flex flex-col gap-4"
            aria-label="Import a file"
          >
            <FormField
              id="import-file"
              label="CSV or JSON file"
              required
              hint={`UTF-8, up to ${formatCount(IMPORT_LIMITS.maxBytes)} bytes and ${formatCount(IMPORT_LIMITS.maxRecords)} records`}
              error={errors.file}
            >
              {(p) => (
                <input
                  {...p}
                  ref={fileInput}
                  type="file"
                  accept=".csv,.json,text/csv,application/json"
                  disabled={busy}
                  onChange={(e) => onFile(e.target.files?.[0] ?? null)}
                  className="block w-full text-sm text-slate-300 file:mr-3 file:rounded-md file:border-0 file:bg-slate-800 file:px-3 file:py-2 file:text-sm file:text-slate-200 hover:file:bg-slate-700"
                />
              )}
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField id="import-format" label="Format" required error={errors.format}>
                {(p) => (
                  <select
                    {...p}
                    className={inputClass}
                    value={format}
                    disabled={busy}
                    onChange={(e) => setFormat(e.target.value as ImportFormat | '')}
                  >
                    <option value="">Choose…</option>
                    <option value="csv">CSV</option>
                    <option value="json">JSON</option>
                  </select>
                )}
              </FormField>
              <FormField
                id="import-source"
                label="Source / provenance"
                required
                hint="Applied to every round in the file. Describe where the data really came from."
                error={errors.source}
              >
                {(p) => (
                  <input
                    {...p}
                    className={inputClass}
                    maxLength={100}
                    disabled={busy}
                    placeholder="e.g. personal-observation-log-2026-01"
                    value={source}
                    onChange={(e) => setSource(e.target.value)}
                  />
                )}
              </FormField>
            </div>
            <FormField
              id="import-notes"
              label="Notes"
              hint="Stored with the import record (max 500 characters)"
            >
              {(p) => (
                <textarea
                  {...p}
                  className={inputClass}
                  rows={2}
                  maxLength={IMPORT_LIMITS.maxNotesLength}
                  disabled={busy}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              )}
            </FormField>
            {requestError ? <ErrorNotice message={requestError} /> : null}
            <div>
              <button
                type="submit"
                disabled={busy}
                className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {stage.kind === 'previewing' ? 'Validating…' : 'Validate and preview'}
              </button>
            </div>
          </form>
        </Panel>
        <Panel title="File format">
          <div className="space-y-3 text-sm text-slate-400">
            <p>
              Fields: <code className="text-slate-300">multiplier</code> (required),{' '}
              <code className="text-slate-300">sourceRoundId</code> and{' '}
              <code className="text-slate-300">eventAt</code> (optional).
            </p>
            <pre className="overflow-x-auto rounded bg-slate-950 p-2 text-xs text-slate-300">
              {'multiplier,sourceRoundId,eventAt\n2.35,R-1001,2026-01-31T14:05:09Z'}
            </pre>
            <pre className="overflow-x-auto rounded bg-slate-950 p-2 text-xs text-slate-300">
              {
                '[{"multiplier": "2.35",\n  "sourceRoundId": "R-1001",\n  "eventAt": "2026-01-31T14:05:09Z"}]'
              }
            </pre>
            <p>
              Event times need a time zone (Z or ±hh:mm). Rows sharing a source round ID with a
              stored round are skipped, never overwritten.
            </p>
          </div>
        </Panel>
      </div>

      {stage.kind === 'preview' || stage.kind === 'confirming' ? (
        <ImportPreviewView
          preview={stage.preview}
          confirming={stage.kind === 'confirming'}
          onConfirm={() => void confirm()}
          onCancel={cancel}
        />
      ) : null}

      {stage.kind === 'done' ? (
        <Notice tone="success">
          <p className="font-medium">Import #{stage.result.import.id} saved.</p>
          <p className="mt-1">
            {formatCount(stage.result.import.recordsAccepted)} new round(s) stored ·{' '}
            {formatCount(stage.result.import.recordsRejected)} invalid ·{' '}
            {formatCount(stage.result.import.recordsDuplicate)} duplicate(s) skipped ·{' '}
            {formatCount(stage.result.import.recordsTotal)} record(s) in file.
          </p>
          <p className="mt-2 flex flex-wrap gap-3">
            <Link className="underline" to={`/rounds?importId=${stage.result.import.id}`}>
              View imported rounds
            </Link>
            <Link className="underline" to="/rounds/imports">
              Import history
            </Link>
            <button type="button" className="underline" onClick={startOver}>
              Import another file
            </button>
          </p>
        </Notice>
      ) : null}
    </div>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) {
    const line =
      typeof error.details === 'object' && error.details !== null && 'line' in error.details
        ? ` (line ${String((error.details as { line: unknown }).line)})`
        : '';
    if (error.code === 'validation_error' && error.fieldErrors.length > 0) {
      return `${error.message}: ${error.fieldErrors.map((d) => `${d.path} ${d.message}`).join('; ')}`;
    }
    return `${error.message}${line}`;
  }
  return error instanceof Error ? error.message : 'Unexpected error';
}
