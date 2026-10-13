import { MAX_BACKTEST_ROUNDS } from './backtest.js';
import { fmix32, Xoshiro128StarStar } from './bootstrap.js';

/**
 * Moving-block sampling primitives for the order-preserving block bootstrap (progression
 * increment 4, step 1). See docs/BLOCK_BOOTSTRAP_DESIGN.md.
 *
 * VIRTUAL MONEY ONLY. These functions only choose WHICH recorded rounds a resampled path
 * contains. They replay nothing and compute no results.
 *
 * Method (non-circular moving blocks, fixed block length b):
 * - The sample is the n eligible recorded rounds in replay order (one source, by event time).
 *   "Consecutive" means consecutive in that recorded sample: rounds missing from the
 *   recording are invisible, so a block may span a gap in the underlying game.
 * - Every run of b consecutive sample positions is a candidate block: starts 0 … n − b
 *   (S = n − b + 1 of them). Blocks never wrap from the end of the sample to its start.
 * - A path draws K = ⌈n / b⌉ starts uniformly and independently, with replacement, and
 *   concatenates the blocks in draw order. The last block is truncated to its first
 *   L = n − (K − 1)·b rounds, so every path has exactly n rounds. Blocks may overlap, and a
 *   round may appear more than once.
 * - Randomness: xoshiro128** per (seed, path), seeded like the IID bootstrap's generator but
 *   with a different constant in the fourth state word, so the two methods never share a
 *   random stream. The IID generator is not used or changed.
 *
 * Keeping recorded order within a block is a sensitivity check. It does not assume or show
 * that rounds depend on each other, and it predicts nothing.
 */
export const MOVING_BLOCK_ALGORITHM_VERSION = 'moving-block-bootstrap/xoshiro128ss-fmix32/v1';

/** Fewest eligible rounds a block bootstrap accepts (so that b = 2 leaves 10 blocks). */
export const MIN_BLOCK_BOOTSTRAP_SAMPLE = 20;
/** b = 1 would be the IID bootstrap under another name, so it is refused. */
export const MIN_BLOCK_LENGTH = 2;
/** Absolute cap on b, keeping blocks short-range and the edge effect bounded. */
export const MAX_BLOCK_LENGTH = 500;
/** Every path mixes at least this many recorded stretches: b ≤ ⌊n / 10⌋. */
export const MIN_BLOCKS_PER_PATH = 10;

/** A sample or block length that this method cannot use. Thrown before any sampling. */
export class BlockBootstrapError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'BlockBootstrapError';
  }
}

function assertSampleSize(n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new BlockBootstrapError(`The sample size must be a whole number, got ${String(n)}`);
  }
  if (n < MIN_BLOCK_BOOTSTRAP_SAMPLE) {
    throw new BlockBootstrapError(
      `A block bootstrap needs at least ${MIN_BLOCK_BOOTSTRAP_SAMPLE} rounds; the sample has ${n}.`,
    );
  }
  if (n > MAX_BACKTEST_ROUNDS) {
    throw new BlockBootstrapError(`The sample exceeds ${MAX_BACKTEST_ROUNDS} rounds.`);
  }
}

/** Largest block length allowed for a sample of n rounds: min(⌊n / 10⌋, 500), always ≥ 2. */
export function maxBlockLength(sampleSize: number): number {
  assertSampleSize(sampleSize);
  return Math.min(Math.floor(sampleSize / MIN_BLOCKS_PER_PATH), MAX_BLOCK_LENGTH);
}

/** The cube root of n rounded half up, computed exactly with integers (no floating cbrt). */
export function roundedCubeRoot(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new BlockBootstrapError(`Expected a non-negative whole number, got ${String(n)}`);
  }
  const N = BigInt(n);
  // Largest r with r³ ≤ n.
  let r = BigInt(Math.floor(Math.cbrt(n)));
  while (r * r * r > N) r -= 1n;
  while ((r + 1n) * (r + 1n) * (r + 1n) <= N) r += 1n;
  // Round half up: ∛n ≥ r + ½  ⇔  8n ≥ (2r + 1)³.
  const twice = 2n * r + 1n;
  return Number(8n * N >= twice * twice * twice ? r + 1n : r);
}

/**
 * Default block length for a sample of n rounds: the cube root of n rounded half up, then
 * clamped to [2, maxBlockLength(n)]. A convention for the order of b, not a data-driven choice.
 */
export function defaultBlockLength(sampleSize: number): number {
  const max = maxBlockLength(sampleSize);
  return Math.min(Math.max(roundedCubeRoot(sampleSize), MIN_BLOCK_LENGTH), max);
}

/** Returns b unchanged if it is valid for n rounds; otherwise throws. Never coerces. */
export function validateBlockLength(sampleSize: number, blockLength: number): number {
  const max = maxBlockLength(sampleSize);
  if (!Number.isSafeInteger(blockLength)) {
    throw new BlockBootstrapError(
      `The block length must be a whole number, got ${String(blockLength)}`,
    );
  }
  if (blockLength < MIN_BLOCK_LENGTH) {
    throw new BlockBootstrapError(
      `The block length must be at least ${MIN_BLOCK_LENGTH}; a length of 1 is the IID bootstrap.`,
    );
  }
  if (blockLength > max) {
    throw new BlockBootstrapError(
      `For ${sampleSize} rounds the block length can be at most ${max}, got ${blockLength}.`,
    );
  }
  return blockLength;
}

/** How every path of a sample is cut into blocks. Depends only on n and b. */
export interface MovingBlockLayout {
  /** n: rounds in the sample, and in every path. */
  sampleSize: number;
  /** b: rounds per full block. */
  blockLength: number;
  /** S = n − b + 1: candidate block starts 0 … n − b. */
  candidateStarts: number;
  /** K = ⌈n / b⌉: blocks per path. */
  blocksPerPath: number;
  /** L = n − (K − 1)·b: rounds kept from the last block (1 ≤ L ≤ b). */
  lastBlockLength: number;
}

export function movingBlockLayout(sampleSize: number, blockLength: number): MovingBlockLayout {
  validateBlockLength(sampleSize, blockLength);
  const blocksPerPath = Math.ceil(sampleSize / blockLength);
  return {
    sampleSize,
    blockLength,
    candidateStarts: sampleSize - blockLength + 1,
    blocksPerPath,
    lastBlockLength: sampleSize - (blocksPerPath - 1) * blockLength,
  };
}

const WARM_UP_DRAWS = 16;

/**
 * The generator for one block-bootstrap path. Seeded exactly like the IID bootstrap's
 * pathGenerator except for the fourth state word's constant (0xbb67ae85 instead of
 * 0x6a09e667). fmix32 is a bijection, so for the same (seed, path) the fourth word always
 * differs: a block path never reuses an IID path's stream.
 */
export function blockPathGenerator(seed: number, pathIndex: number): Xoshiro128StarStar {
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new RangeError('The seed must be a non-negative safe integer');
  }
  if (!Number.isInteger(pathIndex) || pathIndex < 0 || pathIndex > 0xffff_ffff) {
    throw new RangeError('The path index must be a uint32');
  }
  const lo = seed % 0x1_0000_0000;
  const hi = Math.floor(seed / 0x1_0000_0000);
  const s0 = fmix32(lo ^ 0x9e3779b9);
  const s1 = fmix32(hi ^ 0x243f6a88);
  const s2 = fmix32(pathIndex ^ 0xb7e15162);
  // Domain separation from the IID stream; never all zero (s3 is 1 if it would be 0).
  const s3 = fmix32((s0 ^ s1 ^ s2 ^ 0xbb67ae85) >>> 0) || 1;
  const rng = new Xoshiro128StarStar([s0, s1, s2, s3]);
  for (let i = 0; i < WARM_UP_DRAWS; i++) rng.next();
  return rng;
}

/** Anything that draws unbiased indices in [0, n): the generator, or a controlled test stub. */
export interface IndexSource {
  nextIndex(n: number): number;
}

/** Draws a path's K block starts, in order, each uniform over 0 … n − b. */
export function drawBlockStarts(layout: MovingBlockLayout, rng: IndexSource): number[] {
  const starts: number[] = [];
  for (let k = 0; k < layout.blocksPerPath; k++) {
    const start = rng.nextIndex(layout.candidateStarts);
    if (!Number.isInteger(start) || start < 0 || start >= layout.candidateStarts) {
      throw new RangeError(
        `Block start ${String(start)} is outside 0 … ${layout.candidateStarts - 1}`,
      );
    }
    starts.push(start);
  }
  return starts;
}

/**
 * The sample positions of one path, from its block starts: each full block contributes
 * start … start + b − 1 in order; the last contributes its first L positions. Pure.
 */
export function blockPathIndices(layout: MovingBlockLayout, starts: readonly number[]): Int32Array {
  const { sampleSize, blockLength, candidateStarts, blocksPerPath, lastBlockLength } = layout;
  if (starts.length !== blocksPerPath) {
    throw new RangeError(`Expected ${blocksPerPath} block starts, got ${starts.length}`);
  }
  const indices = new Int32Array(sampleSize);
  let position = 0;
  for (let k = 0; k < blocksPerPath; k++) {
    const start = starts[k]!;
    if (!Number.isInteger(start) || start < 0 || start >= candidateStarts) {
      throw new RangeError(`Block start ${String(start)} is outside 0 … ${candidateStarts - 1}`);
    }
    const length = k === blocksPerPath - 1 ? lastBlockLength : blockLength;
    for (let i = 0; i < length; i++) indices[position++] = start + i;
  }
  return indices;
}

/** One resampled path: the block starts drawn, and the sample positions they select. */
export interface MovingBlockPath {
  starts: number[];
  indices: Int32Array;
}

/**
 * The moving-block path p for a sample of n rounds, block length b and seed: deterministic in
 * (n, b, seed, p, MOVING_BLOCK_ALGORITHM_VERSION). Throws BlockBootstrapError for a sample or
 * block length the method cannot use, before drawing anything.
 */
export function movingBlockPath(
  sampleSize: number,
  blockLength: number,
  seed: number,
  pathIndex: number,
): MovingBlockPath {
  const layout = movingBlockLayout(sampleSize, blockLength);
  const starts = drawBlockStarts(layout, blockPathGenerator(seed, pathIndex));
  return { starts, indices: blockPathIndices(layout, starts) };
}

/**
 * The values of a sample at a path's positions, as a new array; the sample is only read.
 * The sample must be a non-empty array of finite numbers whose length is the path's n.
 */
export function gatherBlockPath(sample: readonly number[], indices: Int32Array): number[] {
  if (!Array.isArray(sample) || sample.length === 0) {
    throw new BlockBootstrapError('The sample must be a non-empty array of numbers.');
  }
  if (sample.length !== indices.length) {
    throw new BlockBootstrapError(
      `The path has ${indices.length} positions but the sample has ${sample.length} rounds.`,
    );
  }
  for (const value of sample) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new BlockBootstrapError('The sample must contain only finite numbers.');
    }
  }
  return Array.from(indices, (i) => {
    if (i < 0 || i >= sample.length) {
      throw new RangeError(`Position ${i} is outside the sample`);
    }
    return sample[i]!;
  });
}
