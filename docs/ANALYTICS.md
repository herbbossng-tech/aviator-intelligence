# Historical analytics: definitions and methods

The Analytics page (`/analytics`) and `GET /api/analytics` produce **descriptive statistics** of the stored rounds you select.

> These figures describe the selected historical records. They do not predict the next multiplier or demonstrate that a strategy will be profitable.

The calculations live in `packages/shared/src/analytics.ts`, a framework-free module with unit tests. The server selects the data with SQLite, and the module computes every statistic.

## Data flow

```
SQLite rounds ──filters──▶ GROUP BY multiplier_x100 (one row per distinct multiplier)
                                   │
                                   ▼
                computeAnalytics(frequencyTable)   ← packages/shared/src/analytics.ts
                                   │
                                   ▼
        GET /api/analytics ──Zod-validated JSON──▶ Analytics page (charts, tables)
```

- **Frequency table, not row dumps.** Only one `(multiplier_x100, count)` row per distinct multiplier leaves the database. Memory stays bounded by the number of distinct multipliers, and the browser never downloads individual rounds to compute statistics.
- **One snapshot.** All counts in a response are read in one SQLite transaction, so they describe the same data.
- **Exact integers.** Multipliers stay exact ×100 integers (2.35x = 235). Counts, quantiles, thresholds and histogram bins are integer operations. Only the mean, proportions and interval bounds are floating point. Source records are never rounded or modified.
- **Size limit.** A single request can analyse at most **5,000,000 rounds** (`MAX_ANALYTICS_ROUNDS`); larger selections return `422 dataset_too_large`. This keeps the integer sum of multipliers below 2^53, so the mean is computed from an exact sum.
- **Reproducible.** The same stored data and the same filters always produce the same response.

## Dataset selection

| Query parameter                  | Meaning                                                                                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`                         | Exact source label                                                                                                                                              |
| `importId`                       | Rounds stored by one import                                                                                                                                     |
| `minMultiplier`, `maxMultiplier` | Inclusive multiplier range, as decimal text with the same rules as round input (e.g. `1.5`)                                                                     |
| `eventFrom`                      | Inclusive lower bound on event time: ISO-8601 with an explicit offset, normalised to UTC                                                                        |
| `eventTo`                        | **Exclusive** upper bound on event time                                                                                                                         |
| `thresholds`                     | Comma-separated multipliers for the threshold table, e.g. `1.5,2,10`. At most 20, de-duplicated and sorted. Default: 1.20, 1.50, 2.00, 3.00, 5.00, 10.00, 20.00 |

Unknown parameters return `400 validation_error`, as everywhere else in the API.

- **Synthetic test fixtures** (`is_synthetic = 1`) are never included. If any match the other filters, the response lists them under `dataset.exclusions`.
- **Rounds without an event time** are included unless a date bound is set. A date bound cannot place them in time, so they are then excluded and counted under `dataset.exclusions` (`no_event_time_with_date_filter`). No time is ever invented for them.
- **Denominator:** `dataset.roundsIncluded` is the denominator for **every** proportion in the response.

## Definitions

### Summary

| Statistic                                | Definition                                                                                                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Count                                    | Number of rounds selected                                                                                                                                                  |
| Min, max                                 | Smallest and largest observed multiplier                                                                                                                                   |
| Mean                                     | Σ multiplier / n, from an exact integer sum, reported in ×100 units rounded to 0.01 (0.0001x). The page shows it to 0.01x. Rare very high multipliers pull it up strongly. |
| Quantiles (p25, p50, p75, p90, p95, p99) | **Nearest rank** (inverse empirical CDF; Hyndman & Fan type 1): the smallest observed value v such that at least ⌈p·n⌉ rounds are ≤ v (rank 1 when p = 0)                  |
| Median                                   | The nearest-rank p50. For an even count it is the **lower** of the two middle values, not their average.                                                                   |

The rank ⌈p·n⌉ is computed with exact integer arithmetic (levels are basis points), so floating-point error cannot shift a quantile. Every quantile is an observed multiplier, so it is never interpolated or rounded.

The summary is `null` when no rounds are selected. No NaN or Infinity is ever returned.

### Threshold table: empirical P(M ≥ t)

For each threshold t:

- `count` = number of rounds with multiplier **≥ t** (equality counts as reaching t)
- `denominator` = number of rounds selected
- `proportion` = count / denominator

This is the **observed historical proportion** at or above t, an empirical survival function. It is not a calibrated probability for the next round.

With an empty selection, `proportion` and `ci95` are `null`, not 0.

### 95% confidence interval: Wilson score

```
p̂ = count / n,  z = 1.959963984540054
centre = (p̂ + z²/2n) / (1 + z²/n)
half   = z · √(p̂(1−p̂)/n + z²/4n²) / (1 + z²/n)
interval = [centre − half, centre + half]
```

- **Why Wilson:** unlike the normal ("Wald") interval, it behaves sensibly at small n and near 0% or 100%.
- **Edge cases:**
  - the lower bound is exactly 0 when count = 0
  - the upper bound is exactly 1 when count = n
  - bounds are clamped to [0, 1]
  - with n = 0 the interval is `null`
- **Interpretation:** the interval describes **sampling uncertainty only**, under the assumption that the selected rounds are independent draws from an unchanging process. It does not correct data-quality problems such as missing or mislabelled rounds or selective recording. It does not turn the proportion into a forecast, and it says nothing about whether any strategy is profitable.

### Histogram

Default bin edges (×100): `100, 101, 120, 150, 200, 300, 500, 1000, 2000, 5000, 10000`.

- Bin _i_ covers **lower ≤ M < upper** (lower inclusive, upper exclusive). The last bin, **M ≥ 100.00x**, is open-ended, so the long tail is never dropped.
- Multipliers are integers in ×100 units, so each bin's label shows its exact range. For example, [101, 120) is labelled "1.01x–1.19x". 1.00x has its own bin.
- Every selected round falls in exactly one bin; bin counts sum to the denominator.
- Bins have **unequal widths**. The page therefore draws a bar per bin whose length is the **count**, not a density, and offers a table view with the same numbers.
- The module accepts custom edges, but the first edge must be 1.00x so that every value is covered. The API uses the defaults.

## Ordering and time

- **No use of order.** Every statistic is independent of round order: neither event time nor recording order (`id`, `observed_at`) is used.
- **Event times** are used only for the optional date filter and for the reported earliest and latest event time.
- **Rolling-window summaries are deferred.** A meaningful rolling window needs a trustworthy order within a source. Here, rounds without an event time have none, mixing sources interleaves unrelated sequences, and recording order reflects import batches rather than game order. Rather than ship a misleading window, this pass leaves it out.

## Limitations

- **Quality depends on the inputs.** Results are only as good as the stored data and its provenance labels; the analysis cannot detect missing or selectively recorded rounds.
- **Mean versus median.** Heavy tails make the mean unstable; prefer the median and quantiles for typical behaviour.
- **Multiple comparisons.** Comparing many thresholds or filter combinations increases the chance of seeing a pattern by chance. Each interval is a per-threshold 95% interval, not a simultaneous one.
- **Not implemented here:** strategy backtesting, simulation and risk metrics such as drawdown and risk of ruin. They remain planned; see [PROJECT_SCOPE.md](PROJECT_SCOPE.md).
