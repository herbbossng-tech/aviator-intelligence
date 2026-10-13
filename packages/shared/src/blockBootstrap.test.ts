import { describe, expect, it } from 'vitest';
import {
  BlockBootstrapError,
  blockPathGenerator,
  blockPathIndices,
  defaultBlockLength,
  drawBlockStarts,
  gatherBlockPath,
  MAX_BLOCK_LENGTH,
  maxBlockLength,
  MIN_BLOCK_BOOTSTRAP_SAMPLE,
  MOVING_BLOCK_ALGORITHM_VERSION,
  movingBlockLayout,
  movingBlockPath,
  roundedCubeRoot,
  validateBlockLength,
  type IndexSource,
} from './blockBootstrap.js';
import {
  BOOTSTRAP_ALGORITHM_VERSION,
  fmix32,
  pathGenerator,
  Xoshiro128StarStar,
} from './bootstrap.js';

// SYNTHETIC TEST FIXTURES only. These tests cover which recorded positions a path selects;
// nothing here replays rounds, and nothing is a prediction or recommendation.

/** A scripted index source: returns the given values in order, checking the bound asked. */
function scripted(values: number[], expectedBound?: number): IndexSource {
  let i = 0;
  return {
    nextIndex(n: number) {
      if (expectedBound !== undefined) expect(n).toBe(expectedBound);
      return values[i++]!;
    },
  };
}

/** Splits a path into its blocks: full blocks of b, then the last block of L. */
function blocksOf(indices: Int32Array, b: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < indices.length; i += b) out.push(Array.from(indices.slice(i, i + b)));
  return out;
}

describe('block-length rules', () => {
  it('bounds b by min(⌊n/10⌋, 500), from the 20-round minimum to the sample cap', () => {
    expect(MIN_BLOCK_BOOTSTRAP_SAMPLE).toBe(20);
    expect(MAX_BLOCK_LENGTH).toBe(500);
    expect(maxBlockLength(20)).toBe(2);
    expect(maxBlockLength(29)).toBe(2);
    expect(maxBlockLength(30)).toBe(3);
    expect(maxBlockLength(5_009)).toBe(500);
    expect(maxBlockLength(5_010)).toBe(500);
    expect(maxBlockLength(100_000)).toBe(500);
    for (const n of [19, 0, -1, 20.5, Number.NaN, Number.POSITIVE_INFINITY, 100_001]) {
      expect(() => maxBlockLength(n), String(n)).toThrow(BlockBootstrapError);
    }
  });

  it('rounds the cube root half up, exactly, including at cubes and half-way points', () => {
    // Half-way between r and r + 1 is (r + ½)³ = (2r + 1)³ / 8.
    expect(roundedCubeRoot(15)).toBe(2); // 15 < 15.625 = 2.5³
    expect(roundedCubeRoot(16)).toBe(3);
    expect(roundedCubeRoot(26)).toBe(3);
    expect(roundedCubeRoot(27)).toBe(3);
    expect(roundedCubeRoot(42)).toBe(3); // 42 < 42.875 = 3.5³
    expect(roundedCubeRoot(43)).toBe(4);
    expect(roundedCubeRoot(0)).toBe(0);
    for (const r of [1, 10, 46, 1_000, 99_999, 208_063]) {
      expect(roundedCubeRoot(r ** 3)).toBe(r); // exact cubes, beyond float cbrt precision
      // Just below a cube still rounds to r (for r ≥ 2; ∛0 = 0).
      if (r >= 2) expect(roundedCubeRoot(r ** 3 - 1)).toBe(r);
    }
    // The definition, checked exhaustively: (2k − 1)³ ≤ 8n < (2k + 1)³.
    for (let n = 1; n <= 100_000; n++) {
      const k = BigInt(roundedCubeRoot(n));
      const eight = 8n * BigInt(n);
      expect((2n * k - 1n) ** 3n <= eight && eight < (2n * k + 1n) ** 3n).toBe(true);
    }
    expect(() => roundedCubeRoot(-1)).toThrow(BlockBootstrapError);
    expect(() => roundedCubeRoot(1.5)).toThrow(BlockBootstrapError);
  });

  it('gives a valid default for every eligible n, clamped to [2, max]', () => {
    expect(defaultBlockLength(20)).toBe(2); // ∛20 ≈ 2.71 → 3, clamped to max 2
    expect(defaultBlockLength(30)).toBe(3);
    expect(defaultBlockLength(100)).toBe(5);
    expect(defaultBlockLength(10_000)).toBe(22);
    expect(defaultBlockLength(100_000)).toBe(46);
    for (let n = MIN_BLOCK_BOOTSTRAP_SAMPLE; n <= 100_000; n++) {
      const b = defaultBlockLength(n);
      expect(b >= 2 && b <= maxBlockLength(n) && Number.isInteger(b)).toBe(true);
      expect(validateBlockLength(n, b)).toBe(b);
    }
  });

  it('accepts valid block lengths unchanged and rejects invalid ones without coercing', () => {
    expect(validateBlockLength(100, 2)).toBe(2);
    expect(validateBlockLength(100, 10)).toBe(10);
    expect(validateBlockLength(100_000, 500)).toBe(500);
    const bad: [number, number][] = [
      [100, 1], // the IID bootstrap
      [100, 0],
      [100, -3],
      [100, 2.5],
      [100, Number.NaN],
      [100, Number.POSITIVE_INFINITY],
      [100, 11], // > ⌊100/10⌋
      [100_000, 501], // > 500
      [19, 2], // sample too small
    ];
    for (const [n, b] of bad) {
      expect(() => validateBlockLength(n, b), `${n}, ${b}`).toThrow(BlockBootstrapError);
    }
    expect(() => validateBlockLength(100, '5' as unknown as number)).toThrow(BlockBootstrapError);
  });
});

describe('moving-block layout and paths', () => {
  it('derives S, K and L, with a truncated last block only when b does not divide n', () => {
    expect(movingBlockLayout(23, 2)).toEqual({
      sampleSize: 23,
      blockLength: 2,
      candidateStarts: 22,
      blocksPerPath: 12,
      lastBlockLength: 1,
    });
    expect(movingBlockLayout(100, 10)).toMatchObject({ blocksPerPath: 10, lastBlockLength: 10 });
    expect(movingBlockLayout(101, 10)).toMatchObject({ blocksPerPath: 11, lastBlockLength: 1 });
    expect(movingBlockLayout(109, 10)).toMatchObject({ blocksPerPath: 11, lastBlockLength: 9 });
  });

  it('builds consecutive blocks from the given starts, reaching start n − b, never wrapping', () => {
    const layout = movingBlockLayout(23, 2); // S = 22: starts 0 … 21
    const starts = [21, 0, 21, 5, 6, 0, 20, 1, 21, 3, 4, 21];
    const indices = blockPathIndices(layout, starts);
    expect(Array.from(indices)).toEqual([
      21, 22, 0, 1, 21, 22, 5, 6, 6, 7, 0, 1, 20, 21, 1, 2, 21, 22, 3, 4, 4, 5, 21,
    ]);
    // The last start allowed is n − b = 21: its block ends at the last round (22), and the
    // next block starts afresh rather than continuing to 23 or wrapping to 0.
    expect(() => blockPathIndices(layout, [...starts.slice(0, 11), 22])).toThrow(RangeError);
    expect(() => blockPathIndices(layout, starts.slice(1))).toThrow(RangeError);
    expect(() => blockPathIndices(layout, [...starts.slice(0, 11), -1])).toThrow(RangeError);
  });

  it('draws K starts from a controlled source, asking for exactly S candidates', () => {
    const layout = movingBlockLayout(30, 3); // S = 28, K = 10
    expect(drawBlockStarts(layout, scripted([0, 27, 5, 5, 26, 1, 2, 3, 4, 27], 28))).toEqual([
      0, 27, 5, 5, 26, 1, 2, 3, 4, 27,
    ]);
    expect(() => drawBlockStarts(layout, scripted([28]))).toThrow(RangeError);
  });

  it('gives exactly n valid positions, consecutive inside each block, for many (n, b, seed)', () => {
    for (let seed = 0; seed < 60; seed++) {
      const n = 20 + ((seed * 37) % 400);
      const max = maxBlockLength(n);
      for (const b of new Set([2, defaultBlockLength(n), max])) {
        const layout = movingBlockLayout(n, b);
        const { starts, indices } = movingBlockPath(n, b, seed, seed % 5);
        expect(indices.length).toBe(n);
        expect(starts.length).toBe(layout.blocksPerPath);
        const blocks = blocksOf(indices, b);
        expect(blocks.length).toBe(layout.blocksPerPath);
        blocks.forEach((block, k) => {
          expect(block.length).toBe(k === blocks.length - 1 ? layout.lastBlockLength : b);
          expect(block[0]).toBe(starts[k]);
          expect(starts[k]).toBeGreaterThanOrEqual(0);
          expect(starts[k]).toBeLessThanOrEqual(n - b);
          // Recorded order within the block: each position follows the previous one.
          for (let i = 1; i < block.length; i++) expect(block[i]).toBe(block[i - 1]! + 1);
          expect(block.at(-1)).toBeLessThanOrEqual(n - 1);
        });
      }
    }
  });

  it('lets blocks overlap and repeat rounds, as moving blocks do', () => {
    let overlap = false;
    let repeat = false;
    for (let seed = 0; seed < 50 && !(overlap && repeat); seed++) {
      const { starts, indices } = movingBlockPath(40, 4, seed, 0);
      overlap ||= starts.some((a, i) =>
        starts.some((c, j) => i !== j && a !== c && Math.abs(a - c) < 4),
      );
      repeat ||= new Set(indices).size < indices.length;
    }
    expect(overlap).toBe(true);
    expect(repeat).toBe(true);
  });

  it('draws starts uniformly over 0 … n − b', () => {
    const layout = movingBlockLayout(60, 6); // S = 55
    const counts = new Array<number>(55).fill(0);
    let draws = 0;
    for (let p = 0; p < 2_000; p++) {
      for (const s of drawBlockStarts(layout, blockPathGenerator(9, p))) {
        counts[s]! += 1;
        draws += 1;
      }
    }
    const expected = draws / 55;
    const chiSquare = counts.reduce((sum, c) => sum + (c - expected) ** 2 / expected, 0);
    // 54 degrees of freedom: the 99.9th percentile is about 94. A biased or truncated start
    // range (say 0 … n − b − 1) gives a far larger value or zero counts at an end.
    expect(chiSquare).toBeLessThan(94);
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[54]).toBeGreaterThan(0);
  });

  it('covers interior rounds b times as often as the end rounds (the documented edge effect)', () => {
    // Round i lies in min(i + 1, b, n − i, S) of the S candidate blocks.
    const n = 50;
    const b = 5;
    const layout = movingBlockLayout(n, b);
    const coverage = Array.from({ length: n }, (_, i) =>
      Math.min(i + 1, b, n - i, layout.candidateStarts),
    );
    expect(coverage.slice(0, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(coverage.slice(-5)).toEqual([5, 4, 3, 2, 1]);
    const counts = new Array<number>(n).fill(0);
    const paths = 4_000;
    for (let p = 0; p < paths; p++) {
      for (const i of movingBlockPath(n, b, 123, p).indices) counts[i]! += 1;
    }
    // With b | n every block is full: expected count of round i per path is K · coverage / S.
    for (let i = 0; i < n; i++) {
      const expected = (paths * layout.blocksPerPath * coverage[i]!) / layout.candidateStarts;
      expect(Math.abs(counts[i]! - expected) / expected).toBeLessThan(0.15);
    }
  });
});

describe('random streams and reproducibility', () => {
  it('pins version-1 streams and paths (changing them requires a new algorithm version)', () => {
    expect(MOVING_BLOCK_ALGORITHM_VERSION).toBe('moving-block-bootstrap/xoshiro128ss-fmix32/v1');
    const g = blockPathGenerator(42, 0);
    expect([g.next(), g.next(), g.next()]).toEqual([2287487533, 777534463, 776668633]);
    const h = blockPathGenerator(Number.MAX_SAFE_INTEGER, 7);
    expect([h.next(), h.next(), h.next()]).toEqual([1462832671, 2764436627, 2509781555]);
    expect(movingBlockPath(23, 2, 42, 0).starts).toEqual([
      1, 13, 15, 2, 15, 20, 18, 13, 6, 15, 12, 21,
    ]);
    expect(movingBlockPath(100, 7, 2026, 3).starts).toEqual([
      89, 37, 73, 75, 6, 87, 60, 41, 21, 33, 1, 48, 14, 23, 67,
    ]);
  });

  it('follows the documented derivation (an independent reconstruction)', () => {
    for (const [seed, path] of [
      [0, 0],
      [42, 0],
      [2 ** 32 + 5, 9],
      [Number.MAX_SAFE_INTEGER, 1_999],
    ] as const) {
      const s0 = fmix32((seed % 2 ** 32) ^ 0x9e3779b9);
      const s1 = fmix32(Math.floor(seed / 2 ** 32) ^ 0x243f6a88);
      const s2 = fmix32(path ^ 0xb7e15162);
      const s3 = fmix32((s0 ^ s1 ^ s2 ^ 0xbb67ae85) >>> 0) || 1;
      const reference = new Xoshiro128StarStar([s0, s1, s2, s3]);
      for (let i = 0; i < 16; i++) reference.next();
      const g = blockPathGenerator(seed, path);
      for (let i = 0; i < 20; i++) expect(g.next()).toBe(reference.next());
    }
  });

  it('is deterministic, and different seeds or paths give different draws', () => {
    expect(movingBlockPath(500, 8, 7, 3)).toEqual(movingBlockPath(500, 8, 7, 3));
    const signature = (seed: number, path: number) =>
      movingBlockPath(500, 8, seed, path).starts.join(',');
    const seen = new Set<string>();
    for (const seed of [0, 1, 2, 2 ** 32, 2 ** 32 + 1]) {
      for (const path of [0, 1, 2]) seen.add(signature(seed, path));
    }
    expect(seen.size).toBe(15);
  });

  it('never shares a stream with the IID bootstrap and leaves IID output unchanged', () => {
    // fmix32 is a bijection, so the fourth state word differs for every (seed, path); the
    // first outputs therefore differ too, here checked over many pairs.
    for (const seed of [0, 1, 42, 2 ** 40, Number.MAX_SAFE_INTEGER]) {
      for (let path = 0; path < 50; path++) {
        expect(blockPathGenerator(seed, path).next()).not.toBe(pathGenerator(seed, path).next());
      }
    }
    // The IID version-1 stream (pinned in bootstrap.test.ts) is unaffected by block sampling.
    movingBlockPath(1_000, 10, 42, 0);
    expect(BOOTSTRAP_ALGORITHM_VERSION).toBe('iid-bootstrap/xoshiro128ss-fmix32/v1');
    const iid = pathGenerator(42, 0);
    expect([iid.next(), iid.next(), iid.next()]).toEqual([2596443952, 919555074, 3956504605]);
  });

  it('rejects invalid seeds and path indices like the IID generator', () => {
    for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      expect(() => blockPathGenerator(bad, 0)).toThrow(RangeError);
    }
    expect(() => blockPathGenerator(1, -1)).toThrow(RangeError);
    expect(() => blockPathGenerator(1, 2 ** 32)).toThrow(RangeError);
  });
});

describe('sample handling', () => {
  it('gathers the sample values at a path, without changing the sample or the starts', () => {
    const sample = Object.freeze(Array.from({ length: 25 }, (_, i) => 100 + i * 3));
    const copy = [...sample];
    const layout = movingBlockLayout(25, 2);
    const starts = Object.freeze([0, 23, 4, 4, 10, 11, 12, 13, 22, 1, 0, 23, 5]);
    const indices = blockPathIndices(layout, starts);
    expect(gatherBlockPath(sample, indices)).toEqual(Array.from(indices, (i) => sample[i]));
    expect(sample).toEqual(copy);
    expect(starts).toEqual([0, 23, 4, 4, 10, 11, 12, 13, 22, 1, 0, 23, 5]);
  });

  it('rejects empty, mismatched or malformed samples', () => {
    const { indices } = movingBlockPath(20, 2, 1, 0);
    const good = Array.from({ length: 20 }, () => 150);
    expect(gatherBlockPath(good, indices)).toHaveLength(20);
    expect(() => gatherBlockPath([], indices)).toThrow(BlockBootstrapError);
    expect(() => gatherBlockPath(good.slice(1), indices)).toThrow(BlockBootstrapError);
    expect(() => gatherBlockPath([...good.slice(1), Number.NaN], indices)).toThrow(
      BlockBootstrapError,
    );
    expect(() => gatherBlockPath([...good.slice(1), '150' as unknown as number], indices)).toThrow(
      BlockBootstrapError,
    );
    expect(() => gatherBlockPath('x'.repeat(20) as unknown as number[], indices)).toThrow(
      BlockBootstrapError,
    );
  });

  it('refuses samples below 20 rounds before drawing anything', () => {
    expect(() => movingBlockPath(19, 2, 1, 0)).toThrow(BlockBootstrapError);
    expect(() => movingBlockPath(20, 3, 1, 0)).toThrow(BlockBootstrapError);
    expect(movingBlockPath(20, 2, 1, 0).indices).toHaveLength(20);
  });
});
