import type { RoundDto } from '@aviator/shared';
import { formatMultiplierX100, formatTimestamp } from '../lib/format';

export function RoundsTable({ rounds }: { rounds: RoundDto[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-slate-500 uppercase">
          <tr>
            <th scope="col" className="py-2 pr-4 font-medium">
              Observed
            </th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">
              Multiplier
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              Source
            </th>
            <th scope="col" className="py-2 font-medium">
              Source round ID
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {rounds.map((round) => (
            <tr key={round.id}>
              <td className="py-2 pr-4 text-slate-400">{formatTimestamp(round.observedAt)}</td>
              <td className="py-2 pr-4 text-right font-mono tabular-nums text-slate-100">
                {formatMultiplierX100(round.multiplierX100)}
              </td>
              <td className="py-2 pr-4 text-slate-400">{round.source}</td>
              <td className="py-2 font-mono text-xs text-slate-500">
                {round.sourceRoundId ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
