import type { ReactNode } from 'react';
import {
  MAX_BLOCK_LENGTH,
  MIN_BLOCK_BOOTSTRAP_SAMPLE,
  MIN_BLOCK_LENGTH,
  MIN_BLOCKS_PER_PATH,
} from '@aviator/shared';
import { Panel } from '../../components/Panel';

// What the two resampling methods do, side by side. Every statement here describes the
// shared engines (bootstrap.ts, blockBootstrap.ts, blockBootstrapAnalysis.ts) as they are;
// nothing is computed. No row ranks the methods.

type Method = 'iid' | 'moving-block';

const ROWS: { aspect: string; iid: ReactNode; block: ReactNode }[] = [
  {
    aspect: 'Sampling unit',
    iid: 'One recorded round at a time. Each of the n draws on a path picks a single round at random, with replacement.',
    block:
      'A block of b consecutive recorded rounds. Each block starts at one of the n − b + 1 possible positions, chosen at random with replacement; blocks are joined in the order drawn and the path is cut to n rounds.',
  },
  {
    aspect: 'Recorded order',
    iid: 'Not kept. Each draw is independent of the one before, so rounds appear on a path in random order.',
    block:
      'Kept within each block. Not kept between blocks: where two blocks join, the order is random.',
  },
  {
    aspect: 'Main purpose',
    iid: 'Shows how much the result depends on which rounds were observed, treating them as interchangeable.',
    block:
      'Shows how sensitive the result is to discarding the recorded order, by keeping short stretches of it.',
  },
  {
    aspect: 'Settings required',
    iid: 'Paths and seed.',
    block: `Paths, seed and a block length b: a whole number from ${MIN_BLOCK_LENGTH} to ⌊n / ${MIN_BLOCKS_PER_PATH}⌋ (at most ${MAX_BLOCK_LENGTH}), so every path has at least ${MIN_BLOCKS_PER_PATH} blocks. Needs a sample of at least ${MIN_BLOCK_BOOTSTRAP_SAMPLE} rounds. The default b is the cube root of n, rounded.`,
  },
  {
    aspect: 'Losing streaks',
    iid: 'Not reported.',
    block:
      'Reported in rounds: for each generated block-resampled path, its longest run of rounds with a negative combined net outcome across both legs (a break-even round ends the run). A streak can continue across a block join.',
  },
  {
    aspect: 'Assumptions and limitations',
    iid: 'Treats rounds as independent and identically distributed. Can only recombine the observed multipliers of this one sample.',
    block:
      'Results depend on the chosen block length and on this one sample. Rounds near either end of the sample appear in fewer possible blocks. With few possible starts, paths reuse the same stretches heavily.',
  },
];

const HEADINGS: Record<Method, string> = {
  iid: 'Independent rounds (IID bootstrap)',
  'moving-block': 'Blocks of consecutive rounds (moving-block bootstrap)',
};

export function MethodComparison({ selected }: { selected: Method }) {
  const heading = (m: Method) => (
    <th scope="col" className="py-2 pr-4 font-medium">
      {HEADINGS[m]}
      {m === selected ? <span className="ml-1 text-sky-300 normal-case">(selected)</span> : null}
    </th>
  );
  return (
    <Panel title="How the two methods differ" subtitle="Descriptions of each method, not a ranking">
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[40rem] text-left text-sm" aria-describedby="method-notes">
          <caption className="sr-only">IID and moving-block bootstrap compared</caption>
          <thead className="text-xs text-slate-500 uppercase">
            <tr>
              <th scope="col" className="py-2 pr-4 font-medium">
                Aspect
              </th>
              {heading('iid')}
              {heading('moving-block')}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800 align-top">
            {ROWS.map((r) => (
              <tr key={r.aspect}>
                <th scope="row" className="py-2 pr-4 font-normal whitespace-nowrap text-slate-300">
                  {r.aspect}
                </th>
                <td className="py-2 pr-4 text-slate-400">{r.iid}</td>
                <td className="py-2 pr-4 text-slate-400">{r.block}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div id="method-notes" className="mt-3 space-y-2 text-xs text-slate-500">
        <p>
          In the moving-block bootstrap the same recorded round can appear more than once on a path,
          sampled blocks may overlap, and a block never wraps from the end of the sample back to its
          start.
        </p>
        <p>
          Neither method predicts future multipliers, establishes an edge, or shows that one
          configuration or method is more profitable. Keeping order does not show that rounds depend
          on each other. Shares of paths are frequencies among model paths, not real-world
          probabilities.
        </p>
      </div>
    </Panel>
  );
}
