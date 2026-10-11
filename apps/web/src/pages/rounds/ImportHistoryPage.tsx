import { useState } from 'react';
import { Link } from 'react-router';
import type { ImportDto } from '@aviator/shared';
import { api } from '../../api/client';
import { useApi } from '../../api/useApi';
import { EmptyState } from '../../components/EmptyState';
import { ErrorNotice } from '../../components/ErrorNotice';
import { Pagination } from '../../components/Pagination';
import { Panel } from '../../components/Panel';
import { formatCount, formatTimestamp } from '../../lib/format';

const PAGE_SIZE = 20;

const STATUS: Record<ImportDto['status'], { label: string; className: string }> = {
  completed: { label: 'Completed', className: 'text-emerald-300' },
  completed_with_rejections: {
    label: 'Completed, some records not stored',
    className: 'text-amber-300',
  },
  failed: { label: 'Failed (rolled back)', className: 'text-rose-300' },
  pending: { label: 'Pending', className: 'text-slate-400' },
};

export function ImportHistoryPage() {
  const [offset, setOffset] = useState(0);
  const state = useApi((signal) => api.imports(PAGE_SIZE, offset, signal), [offset]);

  return (
    <Panel
      title="Import history"
      subtitle="Every confirmed import, including failed attempts. Previews are not recorded."
    >
      {state.status === 'loading' ? (
        <p className="text-sm text-slate-500">Loading import history…</p>
      ) : null}
      {state.status === 'error' ? <ErrorNotice message={state.message} /> : null}
      {state.status === 'success' && state.data.total === 0 ? (
        <EmptyState title="No imports yet">
          <Link to="/rounds/import" className="text-sky-400">
            Import a CSV or JSON file
          </Link>{' '}
          to see its outcome here.
        </EmptyState>
      ) : null}
      {state.status === 'success' && state.data.total > 0 ? (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-left text-sm">
              <caption className="sr-only">Import history</caption>
              <thead className="text-xs text-slate-500 uppercase">
                <tr>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Import
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Source
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Status
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">
                    Total
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">
                    Stored
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">
                    Invalid
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    Duplicates
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {state.data.items.map((item) => (
                  <tr key={item.id}>
                    <td className="py-2 pr-3 text-xs text-slate-400">
                      <span className="block font-medium text-slate-200">
                        #{item.id} · {item.format?.toUpperCase() ?? '—'}
                      </span>
                      {formatTimestamp(item.importedAt)}
                    </td>
                    <td className="py-2 pr-3 text-slate-300">
                      {item.source}
                      {item.notes ? (
                        <span className="block text-xs text-slate-500">{item.notes}</span>
                      ) : null}
                    </td>
                    <td className={`py-2 pr-3 text-xs ${STATUS[item.status].className}`}>
                      {STATUS[item.status].label}
                      {item.errorSummary ? (
                        <span className="block text-slate-500">{item.errorSummary}</span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums">
                      {formatCount(item.recordsTotal)}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums">
                      {item.recordsAccepted > 0 ? (
                        <Link
                          className="text-sky-400 hover:text-sky-300"
                          to={`/rounds?importId=${item.id}`}
                        >
                          {formatCount(item.recordsAccepted)}
                        </Link>
                      ) : (
                        '0'
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums">
                      {formatCount(item.recordsRejected)}
                    </td>
                    <td className="py-2 text-right font-mono tabular-nums">
                      {formatCount(item.recordsDuplicate)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            label="Import history pages"
            offset={offset}
            limit={PAGE_SIZE}
            shown={state.data.items.length}
            total={state.data.total}
            onChange={setOffset}
          />
        </>
      ) : null}
    </Panel>
  );
}
