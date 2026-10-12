# Uncertainty analysis (resampled backtests)

Pass 5 adds a sensitivity analysis to completed virtual backtests: how much would the result change if the same observed multipliers had arrived in a different order, or in different proportions?

> **What this is not.**
>
> - It is not a prediction of future rounds.
> - It is not a real-world probability of loss or ruin.
> - It is not evidence that a configuration is, or will be, profitable.
>
> Every figure is conditional on the model below and on one historical sample. Crash-game rounds are designed to be independent, and nothing here can establish a future edge.

## Where the code lives

| Part                           | Location                                                     |
| ------------------------------ | ------------------------------------------------------------ |
| Bootstrap, PRNG, statistics    | `packages/shared/src/bootstrap.ts`                           |
| Shared replay loop             | `packages/shared/src/backtest.ts` (`createSummaryReplayer`)  |
| Service (sample check, limits) | `apps/server/src/simulations/analysis.ts`                    |
| Storage                        | `apps/server/src/db/repositories/analyses.ts`, migration 004 |
| API routes                     | `apps/server/src/http/routes/simulations.ts`                 |
| UI                             | `/simulations/:id/uncertainty` (`UncertaintyPage.tsx`)       |

## Method: IID empirical bootstrap

**Input: one completed backtest run.** An analysis always belongs to a completed run.

- **Sample.** The sample is the **n** multipliers of **every eligible round in the run's dataset**: the same rounds the run's fingerprint covers, with the same single source, import and date range and the same eligibility rules as the backtest. If the historical replay stopped early (for example, at a lower stop after 2 of 12 rounds), the sample still contains all 12; it is not limited to the rounds the replay reached. The eligibility rules are:
  - synthetic fixtures and undated rounds are excluded
  - duplicate or invalid event times are refused
- **Fingerprint check.** The server reads the run's dataset again and recomputes its SHA-256 fingerprint. If it no longer matches the fingerprint stored with the run (for example, new rounds were imported into that source), the analysis is refused with `409 dataset_changed`, so the run and the resampled sample always describe the same data.
- **Paths.** Each of the **P** paths draws **n** multipliers independently and uniformly, **with replacement**, from the sample.
- **Replay.** Each path is replayed with the run's own strategy and settings (stakes, targets, starting bankroll, insufficient-bankroll policy, stops), through the same replay loop as the backtest (`createSummaryReplayer` → the internal `replayCore`, which also powers `runBacktest`).
  - Settlement, exact integer accounting and the safe-integer range checks are therefore identical.
  - There is no second settlement implementation.
- **Independent paths.** Every path starts again from the starting bankroll; paths share no money and no state.

**Why this method.** The IID bootstrap is the simplest resampling scheme that uses only observed values. It never invents a multiplier, it needs no fitted distribution, and its assumption (rounds are independent and identically distributed) matches how crash games are designed to work. It answers one narrow question: how much of the observed result depends on the particular order and mix of these observations?

**Assumptions and limitations**

- **Independence.** The bootstrap assumes rounds are independent and identically distributed. Any dependence between rounds, or drift over time, is ignored, because order is discarded.
- **Only observed values.** Paths only recombine the n observed values. Multipliers that are possible but were not observed (for example, values above the sample's maximum) never appear, so tail risk can be understated, especially for small samples.
- **No new information.** More paths reduce the Monte Carlo noise of the figures. They add **no** new historical information: everything rests on the same n observations.
- **Path length.** Each path has length n, so path results are comparable with the historical run, which replayed up to n rounds.
- **What is not modelled.** The settlement assumptions of the backtest apply unchanged (see [SIMULATION.md](SIMULATION.md)). Timing, latency and platform limits are not modelled.

## Reproducibility

Each analysis records:

- its **seed**
- the **number of paths**
- the **algorithm version** (`iid-bootstrap/xoshiro128ss-fmix32/v1`)
- the run's **dataset fingerprint**
- a snapshot of the run's strategy, settings and dataset request

The same seed, path count, sample (fingerprint) and algorithm version reproduce **identical** results.

The random numbers are specified exactly. `Math.random()` is never used.

- **Seed.** An integer from 0 to 2^53 − 1 (`Number.MAX_SAFE_INTEGER`). The UI suggests a random one and shows it; the API requires it.
- **Per-path generator.** Each path has its own **xoshiro128\*\*** generator (Blackman & Vigna).
  - Its 128-bit state is `fmix32(lo ⊕ 0x9e3779b9)`, `fmix32(hi ⊕ 0x243f6a88)`, `fmix32(path ⊕ 0xb7e15162)` and `fmix32(s0 ⊕ s1 ⊕ s2 ⊕ 0x6a09e667)` (replaced by 1 if zero).
  - `lo` and `hi` are the seed's low and high 32-bit words, and `path` is the 0-based path index. `fmix32` is MurmurHash3's 32-bit finaliser.
  - Distinct (seed, path) pairs therefore always start from distinct states.
  - The first 16 outputs are discarded.
- **Index draws.** Draws are unbiased: a 32-bit output `x` is accepted only if `x < 2^32 − (2^32 mod n)`, and the index is `x mod n`. Otherwise it is redrawn.
- **Draw order.** Path p draws its n indices in order. Index i selects the i-th multiplier of the sample in replay order, which is the order the fingerprint covers.
- **Effect of per-path streams.** Path p's draws do not depend on other paths or on when earlier paths stopped, so changing a stop does not reshuffle other paths.

Tests pin the generator to the published xoshiro128\*\* reference sequence (state 1, 2, 3, 4 gives 11520, 0, 5927040, …) and to an independent BigInt implementation. They also freeze version-1 output values. Any change to these rules must use a new algorithm version.

## Reported figures

**Denominators.** Every count is shown with its denominator. For path figures this is **P**, the number of paths; every path always completes its replay. A request that would make any path exceed the exact integer range is refused as a whole with `422 simulation_out_of_range`, and nothing is stored.

**Distributions.** These are reported for the ending bankroll, the max drawdown (as a % of the running peak, and as an amount), and the number of rounds replayed.

- Each distribution gives the minimum, **p05, p25, p50 (median), p75, p95**, and the maximum across paths.
- Quantiles are **nearest-rank** (Hyndman & Fan type 1): always an actual path's value, never interpolated. This matches the historical analytics.
- These are **empirical quantiles of the resampled paths, not confidence intervals.** For example, "p05–p95 of ending bankroll" says that 90% of the paths under this model ended in that range. It does not estimate a range for any true or future value.

**Other figures**

| Figure                               | Definition                                                                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Net outcome                          | Paths ending above / at / below the starting bankroll (counts of P)                                                                            |
| How paths ended                      | Count of P per stop reason (all rounds replayed; bankroll exhausted; insufficient bankroll; lower stop; upper stop; drawdown stop; max rounds) |
| Configured boundaries                | See the risk metric below; shown **only** for stops the run actually configured                                                                |
| Observed run                         | The historical run's own ending bankroll, max drawdown and stop reason, labelled **Observed**, beside the **Resampled** figures                |
| Paths below / equal / above observed | Where the observed ending bankroll falls among the P path endings                                                                              |

### Configured-boundary frequency (the risk metric)

> **Definition.** The fraction of resampled paths that **ended because they reached the run's configured virtual-bankroll boundary** under this IID empirical bootstrap model.

- **Boundary.** It is either the run's lower bankroll stop (bankroll < threshold after a round) or its max-drawdown stop (drawdown from the running peak ≥ threshold), whichever is configured. Each is counted from the path's stop reason.
- **Denominator.** P, the number of paths.
- **Stop order.** After each round the stops are checked in order: lower, upper, drawdown. A path that meets two on the same round counts under the first.
- **Not configured.** If the run has no such stop, the figure is reported as **not configured**. No boundary is invented.
- **Exhausted bankroll.** A path that runs out of bankroll before reaching the configured lower stop (possible when the stop is below the smallest stake) appears under "bankroll exhausted" in "How paths ended", not here.

This is **not** an unconditional probability of ruin, and not a statement about future real-world risk. It describes the paths this model generated from these n observations. Keep four things apart:

1. **Historical observed drawdown:** what the actual sequence did, shown as **Observed**.
2. **Resampled path outcomes:** what P recombinations of the same values did.
3. **Boundary frequency:** how often those paths hit the configured boundary.
4. **Future real-world risk:** this analysis cannot establish it.

## Data sufficiency and warnings

The sample must be non-empty and fully replayable, or the analysis is refused. Warnings are shown with the results:

| Warning                    | When                          | Meaning                                                                      |
| -------------------------- | ----------------------------- | ---------------------------------------------------------------------------- |
| `small_sample`             | n < 100                       | Too few observations for the resampled spread to be reliable                 |
| `degenerate_sample`        | all n multipliers identical   | Every path is identical, so a zero spread reflects the sample, not certainty |
| `few_distinct_multipliers` | fewer than 10 distinct values | Paths can only combine those values                                          |
| `few_paths`                | P < 200                       | p05 and p95 rest on very few paths and will move with another seed           |

The dataset's exclusion counts (undated and synthetic rounds) are shown beside the sample.

## Computational limits

All limits are checked **before** any resampling.

- **Paths:** 1 to 2,000 per analysis (`MAX_ANALYSIS_PATHS`).
- **Total work:** paths × n ≤ **1,000,000** replayed rounds (`MAX_ANALYSIS_ROUND_STEPS`). The allowed maximum for a run's sample is `min(2000, ⌊1,000,000 / n⌋)`. The API reports it as `maxPaths`, and the UI caps its input to it.
- **Measured cost:** the worst case (10 paths × 100,000 rounds) took about 1.2 s on the development server.

Analyses run synchronously on the single-user local API, so the server is busy for that time.

Only aggregates are stored (about 2 kB of JSON per analysis); individual paths are not.

## Persistence

Migration 004 adds the `simulation_analyses` table. It is additive: earlier migrations are unchanged.

- **What is stored:**
  - the run id
  - `status` (always `completed`)
  - `method` (`iid_bootstrap`)
  - algorithm version, seed, paths and sample size
  - the dataset fingerprint
  - a configuration snapshot
  - the summary JSON
  - timestamps
- **Only completed analyses are stored.** The result is computed in full, then written as one row. A failure at any point stores nothing (`500 analysis_failed`, details only in the server log).
- **Triggers:**
  - an analysis can only be inserted for a **completed** run with the **same dataset fingerprint**
  - rows **cannot be updated** (deleting an analysis is allowed and affects no other record)
- **Deleting a run** cascades to its analyses.

## API

| Method and path                                 | Purpose                                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `POST /api/simulations/:id/analyses`            | Body `{ paths, seed }`, strict. Returns 201 with the stored analysis.                                               |
| `GET /api/simulations/:id/analyses`             | `limit` (≤ 50), `offset`. Returns the run's analyses newest first, plus `maxPaths` and `sampleSize` for its sample. |
| `GET /api/simulations/:id/analyses/:analysisId` | One analysis of that run.                                                                                           |

Errors:

| Code                      | Status | When                                                 |
| ------------------------- | ------ | ---------------------------------------------------- |
| `validation_error`        | 400    | Invalid paths or seed, or an unknown field           |
| `simulation_not_found`    | 404    | Unknown run                                          |
| `analysis_not_found`      | 404    | Unknown analysis, or one that belongs to another run |
| `run_not_analyzable`      | 409    | The run failed                                       |
| `dataset_changed`         | 409    | The sample no longer matches the run's fingerprint   |
| `analysis_too_large`      | 422    | Over the work limit; the details give `maxPaths`     |
| `simulation_out_of_range` | 422    | Exact results would exceed the safe integer range    |
| `analysis_failed`         | 500    | Unexpected failure; nothing is stored                |
| `stored_data_invalid`     | 500    | A stored analysis could not be read back             |

All routes sit behind the loopback Host guard.

## Deferred

- **Block or stationary bootstrap**, which would keep short-range order. It needs a block-length choice, which should be justified first.
- **Confidence intervals** for figures such as the boundary frequency. Any such interval must state exactly what it estimates.
- **Charts.** The results are presented as tables only, for now.
- **Background jobs** for larger analyses.
