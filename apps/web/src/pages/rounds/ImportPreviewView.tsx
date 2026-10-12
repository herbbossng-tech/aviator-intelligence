import type { ImportPreviewResponse, PreviewRowStatus } from '@aviator/shared';
import { ErrorNotice } from '../../components/ErrorNotice';
import { Notice } from '../../components/Notice';
import { Panel } from '../../components/Panel';
import { formatCount, formatMultiplierX100, formatTimestamp } from '../../lib/format';

const STATUS_LABEL: Record<PreviewRowStatus, { label: string; className: string }> = {
  new: { label: 'New', className: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30' },
  invalid: { label: 'Invalid', className: 'bg-rose-500/10 text-rose-300 ring-rose-500/30' },
  duplicate_existing: {
    label: 'Already stored',
    className: 'bg-slate-700/40 text-slate-300 ring-slate-600',
  },
  duplicate_in_file: {
    label: 'Repeat in file',
    className: 'bg-slate-700/40 text-slate-300 ring-slate-600',
  },
};

export function ImportPreviewView({
  preview,
  confirming,
  onConfirm,
  onCancel,
}: {
  preview: ImportPreviewResponse;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { counts } = preview;
  const blocked = preview.alreadyImported !== null || counts.new === 0;
  const cards = [
    ['Records in file', counts.total],
    ['New (will be stored)', counts.new],
    ['Invalid (rejected)', counts.invalid],
    ['Already stored (skipped)', counts.duplicateExisting],
    ['Repeats in file (skipped)', counts.duplicateInFile],
    ['Possible duplicates (warning)', counts.possibleDuplicates],
  ] as const;

  return (
    <Panel
      title="Step 2: review the preview"
      subtitle={`Format ${preview.format.toUpperCase()} · source “${preview.source}”`}
    >
      <div className="flex flex-col gap-5">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          {cards.map(([label, value]) => (
            <div key={label} className="rounded-md border border-slate-800 p-3">
              <dt className="text-xs text-slate-500">{label}</dt>
              <dd className="mt-1 font-mono text-lg text-slate-100 tabular-nums">
                {formatCount(value)}
              </dd>
            </div>
          ))}
        </dl>

        {preview.alreadyImported ? (
          <ErrorNotice
            message={`This exact file was already imported (import #${preview.alreadyImported.importId}, ${formatTimestamp(preview.alreadyImported.importedAt)}). It cannot be imported again.`}
          />
        ) : null}

        <Notice tone="info">
          Confirming will store <strong>{formatCount(counts.new)}</strong> new round(s) with source
          “{preview.source}” and record this import in the history. Invalid records and duplicates
          are not stored, and existing rounds are never changed.
          {counts.possibleDuplicates > 0
            ? ` ${formatCount(counts.possibleDuplicates)} record(s) without a source round ID look identical to other rounds and will still be stored.`
            : ''}
        </Notice>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] text-left text-sm">
            <caption className="sr-only">Preview of records</caption>
            <thead className="text-xs text-slate-500 uppercase">
              <tr>
                <th scope="col" className="py-2 pr-3 font-medium">
                  #
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Status
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">
                  Multiplier
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Source round ID
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Event time (UTC)
                </th>
                <th scope="col" className="py-2 font-medium">
                  Notes
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {preview.rows.map((row) => (
                <tr key={row.recordNumber}>
                  <td className="py-2 pr-3 text-xs text-slate-500">
                    {row.recordNumber}
                    {row.line !== null ? <span className="block">line {row.line}</span> : null}
                  </td>
                  <td className="py-2 pr-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] ring-1 ${STATUS_LABEL[row.status].className}`}
                    >
                      {STATUS_LABEL[row.status].label}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right font-mono tabular-nums">
                    {row.multiplierX100 !== null ? formatMultiplierX100(row.multiplierX100) : '—'}
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs">{row.sourceRoundId ?? '—'}</td>
                  <td className="py-2 pr-3 text-xs">{row.eventAt ?? '—'}</td>
                  <td className="py-2 text-xs">
                    {[...row.issues, ...row.warnings].map((issue, i) => (
                      <span
                        key={i}
                        className={`block ${row.issues.includes(issue) ? 'text-rose-300' : 'text-amber-300'}`}
                      >
                        <code>{issue.code}</code>: {issue.message}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.rowsTruncated ? (
            <p className="mt-2 text-xs text-slate-500">
              Showing the first {preview.rows.length} of {formatCount(counts.total)} records.
            </p>
          ) : null}
        </div>

        {preview.issues.length > 0 ? (
          <details className="rounded-md border border-slate-800 p-3">
            <summary className="cursor-pointer text-sm text-slate-300">
              All validation messages ({formatCount(preview.issues.length)}
              {preview.issuesTruncated ? '+, list truncated' : ''})
            </summary>
            <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto text-xs">
              {preview.issues.map((issue, i) => (
                <li
                  key={i}
                  className={issue.severity === 'error' ? 'text-rose-300' : 'text-amber-300'}
                >
                  Record {issue.recordNumber}
                  {issue.line !== null ? ` (line ${issue.line})` : ''} · <code>{issue.code}</code>:{' '}
                  {issue.message}
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onConfirm}
            disabled={blocked || confirming}
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {confirming ? 'Importing…' : `Confirm import of ${formatCount(counts.new)} round(s)`}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={confirming}
            className="rounded-md px-4 py-2 text-sm text-slate-300 ring-1 ring-slate-700 hover:bg-slate-800 disabled:opacity-50"
          >
            Cancel
          </button>
          <span className="self-center text-xs text-slate-500">
            Preview expires {formatTimestamp(preview.expiresAt)}.
          </span>
        </div>
      </div>
    </Panel>
  );
}
