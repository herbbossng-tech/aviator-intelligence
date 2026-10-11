import { Link } from 'react-router';
import type { RoundDto } from '@aviator/shared';
import { formatMultiplierX100, formatTimestamp } from '../lib/format';

export function RoundsTable({ rounds, caption }: { rounds: RoundDto[]; caption?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] text-left text-sm">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead className="text-xs text-slate-500 uppercase">
          <tr>
            <th scope="col" className="py-2 pr-4 font-medium">
              Event time
            </th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">
              Multiplier
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              Source
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              Source round ID
            </th>
            <th scope="col" className="py-2 font-medium">
              Recorded
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {rounds.map((round) => (
            <tr key={round.id}>
              <td className="py-2 pr-4 text-slate-300">
                {round.eventAt ? (
                  formatTimestamp(round.eventAt)
                ) : (
                  <span className="text-slate-600">not supplied</span>
                )}
              </td>
              <td className="py-2 pr-4 text-right font-mono text-slate-100 tabular-nums">
                {formatMultiplierX100(round.multiplierX100)}
              </td>
              <td className="py-2 pr-4 text-slate-400">{round.source}</td>
              <td className="py-2 pr-4 font-mono text-xs text-slate-500">
                {round.sourceRoundId ?? '—'}
              </td>
              <td className="py-2 text-xs text-slate-500">
                {formatTimestamp(round.observedAt)}
                <span className="block">
                  {round.importId === null ? (
                    'manual entry'
                  ) : (
                    <Link
                      className="text-sky-400 hover:text-sky-300"
                      to={`/rounds?importId=${round.importId}`}
                    >
                      import #{round.importId}
                    </Link>
                  )}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
