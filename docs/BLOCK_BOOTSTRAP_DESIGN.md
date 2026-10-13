# Design: order-preserving block bootstrap (progression increment 4)

> **Status: design approved by the owner; implementation in progress.** Only step 1 (the sampling primitives, [§13](#13-implementation-sequence)) exists, locally and unmerged. The analysis itself, its storage, API and UI do not exist yet.
>
> It proposes how to add a second resampling method to the uncertainty analysis. The existing IID bootstrap ([UNCERTAINTY.md](UNCERTAINTY.md)) and the chronological robustness analysis ([ROBUSTNESS.md](ROBUSTNESS.md)) are unchanged by this design and remain supported. The owner's decisions on [§14](#14-decisions-for-the-owner) are recorded there.

> **What this analysis would be, and what it would not be.**
>
> - Virtual money only. It is a sensitivity analysis of one configuration against one recorded sample.
> - It is **not** a prediction of future rounds, **not** a real-world probability of loss or ruin, and **not** evidence that a configuration or staking progression is, or will be, profitable.
> - Keeping short stretches of rounds in their recorded order does **not** assume, show or imply that crash-game rounds depend on each other. Crash games are designed so that rounds are independent. The block bootstrap only checks how much a result depends on the IID bootstrap's choice to discard order.
> - Martingale and other staking progressions change stake sizes only. They create no predictive edge and guarantee neither recovery nor profit.

## 1. Problem statement

The current uncertainty analysis resamples the n observed multipliers **independently, with replacement**. That discards their order completely. For flat stakes, order matters only through the bankroll path and the stops.

For staking progressions (increments 1–3), order matters directly. A progression's stake grows with **consecutive** losses, its limits are reached by **runs** of losses, and bankroll skips happen when a long cycle meets a depleted bankroll. Under the IID bootstrap, losing streaks occur exactly as often as independent draws produce them. [UNCERTAINTY.md](UNCERTAINTY.md#runs-with-a-staking-progression) already states this limitation.

The question this milestone addresses is narrow:

> If the recorded sequence contains short-range patterns (runs of low or high multipliers, clustering), how different do the resampled outcomes look when such stretches are kept intact rather than shuffled away?

A block bootstrap answers this by resampling **blocks of consecutive recorded rounds** rather than single rounds.

- If block and IID results are similar, the analysis is not sensitive to short-range order in this sample.
- If they differ, the result depends on how the recorded sequence happened to cluster. That is a reason for caution, not a discovery of an edge.

## 2. Existing baseline (verified against `main` at `d8f5d4c`)

| Part                 | Where                                                                      | Relevant behaviour                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IID bootstrap engine | `packages/shared/src/bootstrap.ts` (`runBootstrap`)                        | Draws n indices per path into an `Int32Array` buffer, then replays the buffer with `createSummaryReplayer(strategy, settings, staking)`. It aggregates per-path summaries into nearest-rank distributions, stop-reason counts, the net outcome, configured-boundary counts, an observed comparison, warnings and (for staking plans) a `staking` block. Algorithm version `iid-bootstrap/xoshiro128ss-fmix32/v1`. |
| Random numbers       | `bootstrap.ts` (`pathGenerator`, `Xoshiro128StarStar.nextIndex`)           | xoshiro128\*\* seeded per path from (seed, path index) through `fmix32`, with 16 warm-up draws and unbiased rejection sampling for indices. Frozen v1 outputs are pinned by tests.                                                                                                                                                                                                                                |
| Canonical replay     | `packages/shared/src/backtest.ts` (`createSummaryReplayer` → `replayCore`) | The one replay loop for backtests, bootstrap paths and robustness blocks. The staking plan is validated once and compiled once. Each replay starts every progression from the stepper's initial state, and legs A and B have independent state.                                                                                                                                                                   |
| Sample               | `apps/server/src/db/repositories/simulations.ts` (`loadReplayRounds`)      | Every eligible round of the run's dataset, ordered by `event_at ASC, id ASC`. These are the rounds the run's `dataset_sha256` fingerprints, including any an early-stopped run never reached.                                                                                                                                                                                                                     |
| Service              | `apps/server/src/simulations/analysis.ts` (`runAndStoreAnalysis`)          | Checks the work limits. Re-reads the dataset and compares its fingerprint (409 `dataset_changed`), runs the engine, inserts one row and reads it back.                                                                                                                                                                                                                                                            |
| Storage              | migration 004, `apps/server/src/db/repositories/analyses.ts`               | Table `simulation_analyses` with `method TEXT NOT NULL CHECK (method = 'iid_bootstrap')`, seed, paths, sample size, fingerprint, `config_json` and `summary_json`. Triggers require a completed run with the same fingerprint and refuse updates. On read, each row is checked against its run (snapshot including the plan, fingerprint, seed and paths, staking metadata).                                      |
| API                  | `apps/server/src/http/routes/simulations.ts`                               | `POST /api/simulations/:id/analyses` with a strict `{ paths, seed }` body; `GET` list (with `maxPaths` and `sampleSize`); `GET` one.                                                                                                                                                                                                                                                                              |
| UI                   | `apps/web/src/pages/simulations/UncertaintyPage.tsx`                       | Sample and method panels, a run form (paths, seed), results (distributions, net outcome, boundaries, stop reasons, staking figures) and previous analyses.                                                                                                                                                                                                                                                        |
| Limits               | `bootstrap.ts`                                                             | `MAX_ANALYSIS_PATHS = 2000`, `MAX_ANALYSIS_ROUND_STEPS = 1,000,000` (paths × n), `maxPathsForSample(n)`. The sample may hold at most 100,000 rounds.                                                                                                                                                                                                                                                              |

The IID engine is effectively **"fill a path buffer, then replay it"**, and only the fill step is IID-specific. This is the seam the design uses.

## 3. Statistical objective

**Block bootstrap.** Instead of drawing single observations, draw **blocks**: runs of b consecutive observations from the recorded sequence. Concatenate blocks until the path has n observations. Within each block the recorded order is preserved exactly. Between blocks, the joins are random.

**How it differs from the IID bootstrap**

|                                   | IID bootstrap                       | Block bootstrap                                                      |
| --------------------------------- | ----------------------------------- | -------------------------------------------------------------------- |
| Unit drawn                        | One round                           | b consecutive rounds                                                 |
| Order within a path               | None kept                           | Kept within each block; broken at about n/b block joins              |
| Streaks of length ≤ b in the data | Destroyed, then recreated by chance | Usually kept intact                                                  |
| Streaks longer than b             | Only by chance                      | Only by chance (and by chance joins)                                 |
| Assumption                        | Rounds are i.i.d.                   | Rounds are stationary and dependence (if any) is short relative to b |

**What it can investigate.** Whether outcomes that depend on sequences (losing streaks, progression depth, how often a progression limit is reached, drawdown) change when short-range recorded order is kept. It is a robustness check of the IID figures.

**What it cannot establish**

- It does not test for dependence and cannot show that rounds are dependent. Different results under the two methods can arise from sampling noise in one finite sample, especially for small n, short b or few paths.
- It cannot capture dependence longer than b, or drift over time, which chronological robustness addresses separately.
- Like every bootstrap here, it only recombines observed values and adds no information beyond the n recorded rounds.
- A favourable result is not evidence of a predictive edge.

## 4. Sampling methods considered

| Method                                       | How it works                                                                                                 | Advantages                                                                                                       | Disadvantages                                                                                                                                                                              | Complexity |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| Non-overlapping blocks (Carlstein)           | Cut the sequence into ⌊n/b⌋ fixed blocks; draw blocks with replacement.                                      | Simplest to explain.                                                                                             | Only ⌊n/b⌋ distinct blocks, so a path has much less variety; the result depends on where the cuts fall; leftover rounds at the end need special handling.                                  | Low        |
| **Moving blocks (Künsch), non-circular**     | Every run of b consecutive rounds is a candidate (n − b + 1 starts); draw starts uniformly with replacement. | Every block is a genuine recorded stretch; far more candidate blocks; standard and well studied; easy to verify. | Rounds within b − 1 of either end are covered by fewer blocks, so they are drawn less often (an "edge effect"; see [§5.4](#54-known-edge-effect)).                                         | Low        |
| Circular blocks (Politis & Romano 1992)      | As moving blocks, but the sequence wraps, so blocks may run from the end back to the start.                  | Removes the edge effect: every round is equally likely.                                                          | Wrapped blocks join the **last** recorded round to the **first**, an adjacency that never happened. Across a dataset spanning days, that invents order, which defeats the purpose here.    | Low        |
| Stationary bootstrap (Politis & Romano 1994) | Block lengths are random (geometric with mean b); usually circular.                                          | Less sensitive to the exact b; resampled paths are stationary.                                                   | Random lengths and wrapping are harder to explain and verify; variable-length blocks make "order kept within a block" less predictable for users; it also wraps (same invented adjacency). | Medium     |

### Recommendation: the moving-block bootstrap (non-circular, fixed block length)

- **Only real stretches.** Every block is a stretch of rounds that actually occurred consecutively in the recorded data. No wrap-around adjacency is ever invented.
- **Enough variety.** With n − b + 1 candidate starts, paths are far more varied than with non-overlapping blocks.
- **Auditable.** It is easy to explain on screen ("each path is built from k stretches of b recorded rounds, chosen at random") and easy to check (block starts, lengths and coverage can be verified exactly).
- **Known cost.** Its edge effect is understood and can be measured and disclosed. For the block lengths allowed here (b ≤ n/10) it affects only a small fraction of rounds.

One method only. Circular and stationary variants are **non-goals** for this increment.

## 5. Proposed sampling design

### 5.1 Data

- **Eligible rounds.** Exactly the IID sample: every eligible round of the run's dataset (`loadReplayRounds`), in replay order (`event_at ASC, id ASC`), fingerprinted by `dataset_sha256`. That covers one source, the run's import and date range, synthetic and undated rounds excluded, and duplicate or non-canonical event times refused.
- **Fingerprint check.** The dataset must match the run's fingerprint (409 `dataset_changed`), as today.
- **Order is the stored order.** "Consecutive" means consecutive **in the dataset**, not necessarily consecutive on the platform. Rounds missing from the recording (gaps) are invisible to the sample, so a block may span a recording gap. See [§14, decision 1](#14-decisions-for-the-owner).

### 5.2 Blocks and paths

Notation: n = sample size, b = block length, S = n − b + 1 candidate starts, K = ⌈n / b⌉ blocks per path, L = n − (K − 1) · b the length of the last block (1 ≤ L ≤ b).

1. **Valid blocks.** For every start s in 0 … S − 1, the block is sample indices s, s + 1, …, s + b − 1. Blocks overlap one another; that is inherent to moving blocks.
2. **Path construction.** For path p, draw K starts s₀ … s_{K−1}, each uniformly from 0 … S − 1 and independently, with replacement. The path is the concatenation of sample[s_k … s_k + b − 1] for k < K − 1, followed by the **first L rounds** of block K − 1.
3. **Path length.** Always exactly n, matching the IID bootstrap and the historical run, so figures stay comparable.
4. **Final partial block.** It is truncated: its first L rounds are kept, preserving their order. No round is padded or invented.
5. **Repeats.** The same start may be drawn more than once in a path, and overlapping blocks may be drawn, so a source round may appear more than once (with replacement, as in any bootstrap).
6. **Ordering and boundaries.** Within a block, rounds appear in recorded order. Block boundaries in a path fall at positions b, 2b, …, (K − 1)b. They are fixed by n and b and do not depend on any outcome.

### 5.3 Random numbers and reproducibility

- **Generator.** The same xoshiro128\*\* generator, per-path seeding scheme, warm-up and unbiased `nextIndex` as the IID bootstrap, with one deliberate difference for **domain separation**:
  - The fourth state word uses a different constant: `fmix32(s0 ⊕ s1 ⊕ s2 ⊕ 0xbb67ae85)` instead of `… ⊕ 0x6a09e667`.
  - Because `fmix32` is a bijection, a block path's state never equals the IID state for the same (seed, path).
  - An IID analysis and a block analysis with the same seed therefore do not share a random stream.
  - The IID generator itself is not touched.
- **Draw order.** Path p draws its K starts in order, each with `nextIndex(S)`. No other draws are made. As with IID, a path's draws do not depend on other paths or on when earlier paths stopped.
- **Determinism.** The same sample (fingerprint), configuration (strategy, settings, staking plan), seed, paths, block length and algorithm version give identical results.
- **Algorithm version.** `moving-block-bootstrap/xoshiro128ss-fmix32/v1`. Any change to these rules requires a new version, as for IID.
- **Step 1 implementation.** The rules above are implemented in `packages/shared/src/blockBootstrap.ts`:
  - `blockPathGenerator(seed, path)`: the domain-separated generator;
  - `movingBlockLayout(n, b)`: S, K and L;
  - `drawBlockStarts(layout, rng)`: draws the K starts;
  - `blockPathIndices(layout, starts)`: a path's sample positions;
  - `movingBlockPath(n, b, seed, path)`: all of the above in one call;
  - `gatherBlockPath(sample, indices)`: the sample values at a path's positions;
  - `MOVING_BLOCK_ALGORITHM_VERSION`.

  Invalid samples and block lengths throw `BlockBootstrapError`, a `RangeError` like the IID `AnalysisLimitError`, before anything is drawn. The IID module is not changed.

### 5.4 Known edge effect

Under non-circular moving blocks, round i is contained in min(i + 1, b, n − i, S) of the S candidate blocks. Interior rounds are in b blocks; the first and last b − 1 rounds are in fewer.

Rounds near either end of the dataset are therefore resampled less often than interior rounds. The expected count of round i in a path (ignoring the truncated last block) is about (K · count_i) / S.

The design accepts this, documents it, and tests the exact coverage formula ([§10](#10-validation-strategy)). With b ≤ n/10, at most 2(b − 1) of n rounds (< 20%) are affected, and only by a factor of at most b.

### 5.5 Block length

- **Range.** b is an integer with **2 ≤ b ≤ ⌊n / 10⌋** and b ≤ **500**.
  - b = 1 is the IID bootstrap and is refused, to avoid two names for one method.
  - b ≤ n / 10 guarantees at least 10 blocks per path, so every path mixes at least 10 recorded stretches. That avoids near-copies of the historical sequence.
  - The absolute cap keeps "short-range" meaningful and bounds the coverage edge effect.
- **Minimum sample.** It follows that block bootstrap needs n ≥ 20.
- **Default.** b = clamp(round(n^(1/3)), 2, min(⌊n/10⌋, 500)).
  - "round" is **half up**, computed exactly with integers: the k with (2k − 1)³ ≤ 8n < (2k + 1)³ (`roundedCubeRoot`). No floating-point cube root decides the result.
  - For n = 20 … 29 the cube root rounds to 3 but the maximum is 2, so the default is 2.
  - The default is valid for every n from 20 to 100,000; a test checks every one. The n^(1/3) rule is the common order for block-length selection when estimating distribution quantities (Hall, Horowitz & Jing 1995). It gives about 5 for n = 100, 22 for n = 10,000 and 46 for n = 100,000.
  - The default is a convention, not an optimal choice for this data, and the UI says so.
  - Data-driven selection (for example Politis & White 2004) is a non-goal.
- **Interpretation for progressions.** A block length shorter than the progression's step limit means losing streaks long enough to reach the limit can only form across block joins. The UI shows the chosen b next to each leg's step limit, so the user can judge this. No adjustment is made automatically.

### 5.6 Insufficient or invalid data

| Condition                                        | Response                                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| n < 20                                           | 422 `analysis_sample_too_small` (details: `sampleSize`, `minSampleSize: 20`); nothing stored    |
| b < 2, b not an integer, unknown field           | 400 `validation_error`                                                                          |
| b > ⌊n/10⌋ or b > 500                            | 422 `block_length_too_large` (details: `maxBlockLength` for this sample); checked before replay |
| paths × n over the work limit                    | 422 `analysis_too_large` (details: `maxPaths`), as today                                        |
| Dataset fingerprint changed                      | 409 `dataset_changed`, as today                                                                 |
| Run failed or not completed                      | 409 `run_not_analyzable`, as today                                                              |
| Exact results would leave the safe integer range | 422 `simulation_out_of_range`, as today                                                         |

The range limits are checked from the run's recorded sample size before reading the dataset, then again against the rounds actually read, as the IID service does.

## 6. Progression semantics

Nothing changes in how a path is replayed. Only how its multipliers are chosen changes.

- **Same replay loop.** Each path's n multipliers go to the same `createSummaryReplayer(strategy, settings, staking)` the IID bootstrap uses, so `replayCore` is the only replay loop. There is no second settlement, staking or progression implementation.
- **Fresh state every path.** The staking plan is compiled once per analysis. Each path starts every progression afresh, as today (`statePolicy: "reset_each_path"`), along with the starting bankroll, peak, drawdown, streak and stop state.
  - Progression state is **never** carried between paths.
  - It is also not reset at block joins inside a path: a path is one continuous replay, exactly as a historical run is.
- **Independent legs.** Legs A and B keep independent progression state. Each follows only its own results, and they are funded A then B from the start-of-round bankroll, as in the backtest.
- **Rules unchanged.** Limits, exhausted custom sequences, bankroll skips (transient, not losses), permanent stops, stake-free rounds and session stops behave and are counted exactly as in the backtest.
- **Per-leg figures.** These are defined exactly as in the IID `staking` block: paths that ended with the leg stopped by a limit or an exhausted sequence, and paths with at least one stake the bankroll could not fund, each with denominator P.

## 7. Statistical outputs

The block result reuses the IID summary shape, so the two can be shown side by side, plus resampling metadata.

- **Unchanged figures.** These are all computed from the same per-path replay summaries:
  - ending bankroll, max drawdown (fraction and amount) and rounds replayed: min, p05, p25, p50, p75, p95 and max, nearest-rank;
  - net outcome counts (above / at / below the start), i.e. the share of paths finishing below the starting bankroll, with its denominator;
  - stop-reason counts and configured-boundary counts (only for stops the run configured);
  - the observed comparison and the per-leg `staking` block.
- **Added: longest losing streak distribution.** The longest run of consecutive rounds with a negative round net. This is already computed by `replayCore` for every replay (`longestLosingStreak`), so nothing new is calculated.
  - It is the figure most directly affected by keeping order, which is why it is added here.
  - It is **not** added to IID results, whose version-1 output stays unchanged. The comparison view shows "not reported" for IID ([§14, decision 4](#14-decisions-for-the-owner)).
- **Added: `resampling` metadata.** `{ method: "moving_block", blockLength: b, blocksPerPath: K, lastBlockLength: L, candidateStarts: S }`.
- **Warnings.** The IID warnings apply unchanged (`small_sample`, `degenerate_sample`, `few_distinct_multipliers`, `few_paths`). One is added:
  - `few_candidate_blocks` when S < 100: few distinct stretches exist, so paths reuse the same stretches heavily.
- **Not reported.** No confidence intervals, no p-values, no test of dependence, no "probability of profit". Every figure is a count or quantile of the resampled paths under the stated model, with its denominator.

## 8. Configuration, identity, persistence and API

### 8.1 Is a migration needed? Yes.

Migration 004 constrains `simulation_analyses.method` to exactly `'iid_bootstrap'`. A block analysis cannot be stored there truthfully without changing that CHECK. In SQLite, that means rebuilding the table, which rewrites every existing analysis row. The project's rule that existing records are never rewritten rules this out.

**Recommended: an additive migration 007** that creates a new table, `simulation_block_bootstrap_analyses`, mirroring migration 004.

- **Columns.** The same as 004, plus `block_length INTEGER NOT NULL CHECK (block_length BETWEEN 2 AND 500)`. `method` is constrained to `'moving_block_bootstrap'`.
- **Triggers.** The same as 004:
  - inserts are allowed only for a completed run with the same `dataset_sha256`;
  - rows cannot be updated;
  - deleting a run cascades to its analyses.
- **Existing data.** Untouched: `simulation_analyses` and its rows, migrations 001–006, runs, ledgers, rounds and robustness analyses. This follows the precedent of migration 005, which added robustness analyses as their own table.

### 8.2 Identity and stored configuration

- **Identity of a stored analysis.** The run (whose strategy, settings and staking plan are immutable), the dataset fingerprint, the method, the algorithm version, the seed, the path count and the block length.
  - IID and block analyses live in different tables with different methods and versions, so they cannot collide.
  - Two block analyses differing only in b are distinct rows.
- **Snapshot.** `config_json` stores the same snapshot as IID (`configSnapshot(run)`: strategy, settings and dataset request, plus the staking plan when there is one). The block length and resampling metadata are in their own column and in the summary.
- **No caching.** Analyses are computed on request and stored; nothing is reused across requests. This design keeps that.

### 8.3 Read-time validation

Each stored block analysis is checked against its run on every read, like IID analyses. On any failure the response is 500 `stored_data_invalid`, and the row is never repaired or skipped.

- **Snapshot.** It must equal the run's strategy, settings, dataset request and staking plan.
- **Fingerprint.** It must equal the run's.
- **Columns against the summary.** The seed, paths, sample size, block length and algorithm version must agree with the summary.
- **Resampling metadata.** It must be internally consistent: K = ⌈n/b⌉, L = n − (K − 1)b, S = n − b + 1, and 2 ≤ b ≤ ⌊n/10⌋.
- **Staking metadata.** It must identify exactly the run's progressions, and be absent for a flat run. Per-leg counts must not exceed P.
- **Distributions.** Each must be ordered (min ≤ p05 ≤ … ≤ p95 ≤ max).
- **Counts.** Stop-reason counts and net-outcome counts must each sum to P.

**IID unaffected.** Old IID analyses, and new ones, keep being read by the existing code path, unchanged.

### 8.4 API

Recommended: a separate resource, so the IID API stays exactly as it is ([§14, decision 2](#14-decisions-for-the-owner)).

| Method and path                                       | Purpose                                                                                                                    |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/simulations/:id/block-analyses`            | Strict body `{ paths, seed, blockLength }` → 201 with the stored analysis                                                  |
| `GET /api/simulations/:id/block-analyses`             | Newest first, `limit` ≤ 50, `offset`; also `maxPaths`, `sampleSize`, `maxBlockLength` and `defaultBlockLength` for the run |
| `GET /api/simulations/:id/block-analyses/:analysisId` | One analysis of this run (404 `block_analysis_not_found` otherwise)                                                        |

Errors are as in [§5.6](#56-insufficient-or-invalid-data). Ordinary invalid input is 400 or 422, never 500. The routes sit behind the existing loopback Host guard.

## 9. User interface

- **Where.** The existing uncertainty page (`/simulations/:id/uncertainty`) gains a **method** choice: "Independent rounds (IID bootstrap)", the default and unchanged, or "Blocks of consecutive rounds (block bootstrap)".
- **Settings and defaults.**
  - Paths and seed are as today.
  - Block length is pre-filled with the default from [§5.5](#55-block-length), editable within 2 … `maxBlockLength`, and labelled "rounds per block".
  - The form shows K and L for the chosen b (for example "each path is 98 blocks of 22 rounds plus one of 4").
- **Method text,** in plain language:
  - Each path is built from randomly chosen stretches of b consecutive recorded rounds. Inside a stretch the recorded order is kept; between stretches it is not.
  - Keeping order is a robustness check, not a claim that rounds influence each other. Crash rounds are designed to be independent.
  - Losing streaks longer than b can only form by chance across joins. The page shows b beside each progression leg's step limit.
  - Rounds near the start and end of the dataset are drawn somewhat less often.
  - The results are not predictions, not real-world probabilities and not evidence of profit. A progression creates no edge and guarantees no recovery.
- **Comparison.** When the run has both an IID and a block analysis, a "Compare methods" table shows the same figures side by side. Each column is labelled with its method, seed, paths and (for blocks) b.
  - The page states that differences may partly be Monte Carlo noise. A larger path count reduces that noise but adds no information.
  - No "winner" is declared.
- **Results.** Block results are labelled "Resampled (block bootstrap, b = …)" everywhere, distinct from "Resampled (IID)" and "Observed".
- **Lists.** Previous analyses of both methods are listed with their method.

## 10. Validation strategy

Each test names the defect it is designed to catch. The fixtures are synthetic and in memory, and the real database is never used.

**Sampling primitives (shared)**

1. **Pinned v1 sequences.** With a fixed seed, sample and b, the block starts and the resulting path are frozen. This catches any unintended change to the generator, draw order or truncation, which would silently change stored results without a version bump.
2. **Consecutive order inside blocks.** With sample[i] = i (a strictly increasing marker sequence), every path splits at multiples of b into runs that increase by exactly 1. Only the final run has length L, and every run lies within 0 … n − 1. This catches off-by-one block ends, wrong truncation or wrap-around.
3. **Valid starts and length.** Every start is in 0 … S − 1, the path length is exactly n, and K and L follow the formulas, for many seeded (n, b) pairs including b dividing n, b = 2 and b = ⌊n/10⌋. This catches index overflow and wrong path lengths.
4. **Determinism and seed sensitivity.** The same inputs give an identical path. A different seed or path index gives a different sequence of starts. This catches non-determinism and shared state.
5. **Domain separation.** For the same (seed, path), the block generator's state differs from the IID generator's, and IID's pinned v1 outputs are unchanged. This catches stream reuse or accidental modification of the IID generator.
6. **Known-coverage statistics.** Over many seeded paths, the empirical frequency of each start is close to 1/S (bounded chi-square with a fixed seed). The mean count of round i matches the coverage formula of [§5.4](#54-known-edge-effect). This catches biased start selection and an undocumented edge effect.

**Engine with replay (shared)**

7. **Canonical agreement.** For each path, reconstruct the documented draws independently and run `runBacktest` on that path. Its summary must equal what the engine aggregated: the distributions, stop reasons, streak distribution and per-leg staking counts. Seeded flat and progression configurations are used. This catches any second replay implementation or any divergence from the backtest.
8. **No state leakage.** A reused replayer gives identical results regardless of earlier paths, and every path equals a fresh backtest (covered by 7). This catches progression or bankroll state carried between paths.
9. **Independent legs, limits and skips.** Fixtures are tight enough that limits, exhausted sequences and bankroll skips occur, with assertions that they do so they are not vacuous. Per-leg counts must equal those of independent backtests. This catches leg cross-talk and miscounted stops.
10. **Order actually reaches the replay.** With one enabled leg (the streak is computed on each round's net), an alternating loss/win sequence and an even b, block paths contain losing streaks of length at most 2, created only at joins, whereas IID paths with the same P contain longer ones. With a clustered sequence (a long losing stretch, then a winning one), the block bootstrap's median longest losing streak is at least the IID median. This catches an implementation that silently shuffles within blocks.
11. **Insufficient data and parameters.** n < 20, b = 1, b > ⌊n/10⌋ and b > 500 are refused before any replay. This catches unbounded work and degenerate paths.

**Server**

12. API results equal the shared engine. Repeating a request gives an identical summary. IID and block analyses of the same run are listed separately and have distinct identities.
13. Validation returns 400 or 422 (never 500) for missing or invalid `blockLength`, unknown fields, too-large b, too many paths and too-small samples.
14. Read-time validation: rows copied onto a flat run, a snapshot without the plan, wrong metadata (K, L or S inconsistent with n and b), mismatched columns, unordered quantiles or counts not summing to P each give 500 `stored_data_invalid`, while genuine rows read back.
15. Migration 007: a schema-6 database with IID analyses migrates. Existing `simulation_analyses` rows are byte-identical afterwards and still read back. Block analyses then work on old and new runs. This catches a rewrite of old records.

**Web**

16. The method choice, default b, K and L display, method text and warnings render. The comparison table labels each method and never declares a winner. IID-only runs render exactly as before.

## 11. Performance and limits

- **Cost.** It is dominated by replay (paths × n rounds), the same as IID. Sampling draws K = ⌈n/b⌉ indices per path instead of n, so it is cheaper, and copying blocks is linear in n.
- **Limits.** The existing ones are reused unchanged: P ≤ 2000, P × n ≤ 1,000,000 replayed rounds (`maxPathsForSample`), and n ≤ 100,000. No limit is raised.
- **Block length.** 2 ≤ b ≤ min(⌊n/10⌋, 500) adds no work.
- **Checked before computing.** All limits are checked before any replay, from the recorded sample size and again from the rounds read. Requests are synchronous, as today; the existing worst case was measured at about 1.2 s.

## 12. Risks and limitations

- **Recording gaps.** Blocks may span gaps in the recording, so "consecutive" means consecutive in the dataset ([§14, decision 1](#14-decisions-for-the-owner)).
- **Choice of b.** Results can depend on b. The default is a convention; users can compare several values, but each is a separate stored analysis.
- **Edge effect.** Rounds near the ends are under-sampled ([§5.4](#54-known-edge-effect)).
- **Dependence beyond b.** Dependence longer than b, and drift over time, are not captured.
- **Two methods, one sample.** Differences between methods on one finite sample are easily over-read. The UI and docs must say that they are sensitivity indications, not evidence of dependence or of an edge.
- **Few stretches.** With small n, there are few distinct stretches (S small). The `few_candidate_blocks` and `small_sample` warnings apply.

## 13. Implementation sequence

Each increment ends with green repository checks (`format:check`, `lint`, `typecheck`, `test`, `build`, `check`, `git diff --check`) and no change to IID results (frozen v1 tests).

| #   | Increment              | Scope                                                                                                                                                                                                   | Acceptance criteria                                                                                          |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | Sampling primitives    | `packages/shared`: block-length rules and default, domain-separated generator, `fillMovingBlockPath`, constants and errors                                                                              | Tests 1–6 and 11 pass; IID frozen outputs unchanged; no server or UI change                                  |
| 2   | Block bootstrap engine | `packages/shared`: `runBlockBootstrap` reusing the IID aggregation (refactored behind a shared helper, without changing IID output), streak distribution, resampling metadata, warnings, summary schema | Tests 7–10 pass; IID results byte-identical (frozen tests); progression semantics as in §6                   |
| 3   | Persistence and API    | Migration 007, repository with read-time validation, service with limit checks, routes and error codes                                                                                                  | Tests 12–15 pass; existing rows untouched; old databases migrate; ordinary invalid input never gives 500     |
| 4   | UI and documentation   | Method choice, block length, K and L, method text, comparison table, results labels; UNCERTAINTY.md section; tracker                                                                                    | Test 16 passes; copy reviewed against §3 and §9; no claim of prediction or edge                              |
| 5   | Final review and PR    | Full diff review, repeated test runs, draft PR                                                                                                                                                          | All checks green locally and in CI; PR opened as a draft for the owner; nothing merged without authorisation |

## 14. Decisions for the owner

**Owner decisions (recorded for step 1):**

- Moving blocks only (decision 5).
- Blocks may span recording gaps, and the limitation is documented (decision 1).
- A separate `/block-analyses` endpoint (decision 2).
- The block-length rules and default of §5.5, with a 20-round minimum (decision 3).
- IID results unchanged, with no IID streaks in this increment (decision 4).

The original options follow.

1. **Recording gaps.** Should blocks be allowed to span gaps in the recorded sequence?
   - **Recommended:** yes for v1, documented as above. Detecting gaps would need a cadence definition the data does not provide.
   - **Alternative:** split candidate blocks at event-time gaps above a threshold the owner chooses.
2. **API shape.**
   - **Recommended:** a separate `/block-analyses` resource and table.
   - **Alternative:** one `/analyses` endpoint with a `method` discriminator. That changes the existing endpoint's contract and still needs the new table.
3. **Block-length limits and default.** Confirm 2 ≤ b ≤ min(⌊n/10⌋, 500), with a default of round(n^(1/3)) clamped to that range, and the minimum sample of 20.
4. **Streak distribution for IID.** Leave IID version 1 unchanged, so the comparison shows "not reported" for its streaks (recommended)? Or add streaks to IID under a new IID algorithm version later?
5. **Moving blocks only.** Confirm the single method (non-circular moving blocks) for this increment.

## 15. Non-goals

- Circular, stationary or non-overlapping block bootstraps; data-driven block-length selection; tests of dependence; confidence intervals or p-values.
- Any change to the IID bootstrap's sampling or results, to chronological robustness, to the progression engine or to the backtest replay.
- Any change to existing migrations, stored runs, ledgers, analyses or round data.
- Background jobs or higher work limits.
- Real-money betting, automated betting, platform authentication or access-control bypasses, CAPTCHA bypasses, stealth automation, or evading platform restrictions. All remain out of scope for the whole project.

## References

- Künsch, H. R. (1989). The jackknife and the bootstrap for general stationary observations. _Annals of Statistics_ 17(3).
- Carlstein, E. (1986). The use of subseries values for estimating the variance of a general statistic from a stationary sequence. _Annals of Statistics_ 14(3).
- Politis, D. N. & Romano, J. P. (1992). A circular block-resampling procedure for stationary data. In _Exploring the Limits of Bootstrap_.
- Politis, D. N. & Romano, J. P. (1994). The stationary bootstrap. _Journal of the American Statistical Association_ 89(428).
- Hall, P., Horowitz, J. L. & Jing, B.-Y. (1995). On blocking rules for the bootstrap with dependent data. _Biometrika_ 82(3).
- Politis, D. N. & White, H. (2004). Automatic block-length selection for the dependent bootstrap. _Econometric Reviews_ 23(1).
