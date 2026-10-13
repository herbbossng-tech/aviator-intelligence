# Chronological robustness analysis

Pass 6 adds a historical robustness check for completed virtual backtests: does a run's result hold up across separate periods of the same data, or does it depend on one stretch of it?

> **Read this first.**
>
> - It replays **recorded history only**. Every block is in-sample: the same data the run already used.
> - It is **not out-of-sample validation** and **not a prediction** of future rounds.
> - It does **not** show that a configuration is, or will be, profitable. A block that ended above its starting bankroll says nothing about future rounds.
> - A saved analysis records what the engine calculated. Saving it does not make it a prediction or a recommendation.
> - Virtual money only. Nothing is placed, staked or cashed out anywhere.

## Method

Everything runs on the server through the shared engine (`packages/shared/src/robustness.ts`). The client only chooses how many blocks to use.

1. **Data.** The sample is every eligible round of the run's dataset, in replay order: one source, the run's import and date range, synthetic and undated rounds excluded, ordered by event time. These are the same rounds the run's dataset fingerprint covers, including any that an early-stopped run never reached. See [SIMULATION.md](SIMULATION.md) for the eligibility rules.
2. **Blocks.** The rounds are split into **W** contiguous, non-overlapping blocks (W from 2 to 10).
   - Sizes differ by at most one; the earliest blocks take the remainder (for example, 100 rounds in 3 blocks gives 34, 33, 33).
   - Every block must have at least **30** rounds, so a sample needs at least 30 × W rounds.
   - Boundaries depend only on the round count and the replay order. Multipliers and results never move a boundary, and no round is dropped.
3. **Replays.** The full sample is replayed once, and each block is replayed **on its own**:
   - with the run's exact strategy and settings, through the same replay loop and settlement rule as the historical backtest (`createSummaryReplayer`);
   - starting again from the configured bankroll, with fresh peak, drawdown, streak and stop state;
   - with every stop rule and `maxRounds` applying within the block.
4. **Reported per block:** its position in the sample, its first and last round ids and stored event times, and the usual backtest summary (ending bankroll, net, drawdown, rounds replayed, stop reason, legs).

**Block results are not added together.** The full-sample replay carries the bankroll from one round to the next; separate blocks each restart from the configured bankroll. The blocks therefore do not sum to the full-sample result, and the page never presents them as if they did.

The full-sample replay must equal the run's own stored result. The server checks this before saving.

## Runs with a staking progression

A run whose legs use staking progressions (see [PROGRESSION.md](PROGRESSION.md)) is analysed with the same blocks and the same rules. Only the stakes differ.

> A progression only changes stake sizes. It does not create a predictive edge, and no progression guarantees recovery or profitability. Every block is still in-sample history.

- **Replay.** The full sample and every block are replayed with the run's **stored** staking plan, through the backtest's replay loop. Each leg keeps its own progression state. The backtest's funding order, bankroll skips, permanent limits and custom-sequence end apply unchanged. The full-sample replay must still equal the run's stored summary, progression summary included.
- **State at block boundaries: reset.** Every block restarts each progression at its first step, with no cycle loss and no limit reached (`statePolicy: "reset_each_block"`), just as it restarts the bankroll, drawdown, streak and stop state.
  - A losing cycle still open at the end of one block does **not** continue into the next.
  - A leg stopped by a limit in one block is active again at the start of the next.
  - The full-sample replay, by contrast, carries the progression through the whole period, exactly as the run did.
- **Why reset, not carry.** Carrying a progression's step into a block that restarts the bankroll would mix two starting points: a fresh bankroll with a stake sized for losses that block never saw. Resetting keeps each block an answer to the same question as before: "how would this configuration have done if started at the beginning of that period?". The two policies are not equivalent; only reset is implemented.
- **Recorded in the result.** The result gains a `staking` block, present only for progression runs. It records the state policy and, per leg, the mode and configuration key. Each block's summary also carries its own progression summary (final status, highest step placed, skips), and the page shows where a limit stopped a leg within a block.
- **Flat-stake runs are unchanged.** Their results have no `staking` block, and the algorithm (`chronological-blocks/v1`) and result format (`1`) versions are unchanged.

## Assumptions and limitations

- **Few, short periods.** With at most 10 blocks there are at most 10 historical periods to compare. Variation between them is descriptive; no statistical test is applied, and none of it is a probability.
- **In-sample only.** The configuration was chosen before (or while) looking at this data. A real out-of-sample check would need a selection rule fixed in advance and data the choice never saw. That is not implemented.
- **Restarted bankroll.** Each block restarting from the configured bankroll answers "how would this configuration have done if started at the beginning of that period?". It does not describe a continuous run across periods.
- **Short blocks are noisy.** A block of 30 rounds says little. Prefer fewer, larger blocks when the sample is small.
- **Ordering relies on event times.** Blocks follow the stored event times. The engine refuses event times that are not real instants in the canonical UTC form the app writes, because only that form sorts chronologically as text.
- **Independent of the bootstrap.** The uncertainty analysis ([UNCERTAINTY.md](UNCERTAINTY.md)) resamples rounds as if independent and discards their order. Robustness blocks keep the order but have only W data points. Each depends on its own assumptions; neither adds information beyond the recorded rounds.

## Limits

- Blocks: 2 to 10, each with at least 30 rounds. The API reports the largest allowed count for a run as `maxWindows`.
- Sample: at most 100,000 eligible rounds (the backtest limit).
- Work: configurations × 2 × sample size ≤ 1,000,000 replayed rounds. With one configuration, the 100,000-round sample limit is the tighter bound. A 100,000-round analysis with 10 blocks took about 0.5–0.65 s in development.
- Requests that the run's recorded sample size cannot support are refused (422) before the dataset is read.

## Persistence

Migration **005** adds `simulation_robustness_analyses`. It is additive: earlier migrations are unchanged.

- **One row per analysis**, written only after the result has been computed **and verified**. A failure stores nothing.
- **Columns:** `simulation_run_id`, `status` (`completed` only), `method` (`chronological_blocks`), `algorithm_version`, `result_schema_version`, `windows`, `sample_size`, `dataset_sha256`, `config_json` (the strategy, settings and dataset selection used), `result_json`, timestamps.
- **Triggers:** an analysis may only be attached to a completed run with the **same dataset fingerprint**; rows **cannot be updated**.
- **Deletion:** a single analysis can be deleted (nothing else depends on it). Deleting a run cascades to its robustness analyses. Historical rounds and runs are never modified.

### Versions

- `algorithm_version` is `chronological-blocks/v1`: how blocks are formed and replayed.
- `result_schema_version` is `1`: the layout of `result_json`.
- The application refuses to read a row with a version it does not know (500 `stored_data_invalid`) instead of guessing.

### Creation sequence

1. The run must be completed, with a summary and a fingerprint (409 `run_not_analyzable`).
2. The block count is checked against the run's recorded sample size (422 `robustness_sample_too_small`), before anything is read.
3. The dataset is read in one read transaction. Its fingerprint must equal the run's (409 `dataset_changed`); a client-supplied fingerprint is never accepted.
4. Limits are checked again against the rounds actually read.
5. The engine computes the result, outside any transaction.
6. The result is verified strictly (see below), including against the source rounds and the run's stored summary.
7. In one write transaction the rounds are fingerprinted again, so a change since step 3 is refused (409), and the row is inserted.

### Verification on write and on every read

`verifyBlockRobustnessResult` checks much more than field types:

- the algorithm and result-format versions are supported;
- the declared block count equals the request and the number of blocks;
- the declared sample size equals the source;
- block indices are 0…W−1, and boundaries are contiguous with no gap or overlap, start at 0, end at the sample size, and equal the chronological partition exactly;
- event times are canonical UTC, increase within each block and strictly between blocks, and match the full sample at both ends;
- every summary reconciles exactly (ending = starting + net, net = returned − staked, round counts, leg totals), starts from the configured bankroll and matches the strategy's legs;
- every summary's progression block is present exactly for the plan's legs, with the plan's modes and configuration keys, and its skips and completed cycles reconcile with the leg's totals; the result's `staking` block identifies exactly the plan's progressions, and is absent for a flat-stake run;
- the full-sample summary equals the run's stored summary.

When creating, the block boundaries are also checked against the source rounds' ids and event times. When reading, the stored configuration (staking plan included) and fingerprint must still equal the run's. Snapshots written before staking existed have no `staking` key, which is read as flat stakes, so no migration was needed. Any failure is reported, never repaired: 500 `robustness_failed` on creation (nothing stored), or 500 `stored_data_invalid` on reading (the row is left untouched and the cause is logged on the server).

## API

All endpoints are loopback-only, like the rest of the API.

| Endpoint                                             | Purpose                                                                                                               |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `POST /api/simulations/:id/robustness`               | Body `{ "windows": 2…10 }` (strict). `201` with the stored analysis.                                                  |
| `GET /api/simulations/:id/robustness`                | Newest first. Query `limit` (1–50, default 20), `offset`, optional `windows` filter. Also `maxWindows`, `sampleSize`. |
| `GET /api/simulations/:id/robustness/:analysisId`    | One analysis of this run.                                                                                             |
| `DELETE /api/simulations/:id/robustness/:analysisId` | `204`; `404` if it does not exist.                                                                                    |

| Code                            | Status | Meaning                                                           |
| ------------------------------- | ------ | ----------------------------------------------------------------- |
| `validation_error`              | 400    | Invalid body or query                                             |
| `simulation_not_found`          | 404    | Unknown run                                                       |
| `robustness_analysis_not_found` | 404    | Unknown analysis for this run                                     |
| `run_not_analyzable`            | 409    | The run failed and has no results (progression runs are accepted) |
| `dataset_changed`               | 409    | The run's rounds changed since it ran, or while the analysis ran  |
| `robustness_sample_too_small`   | 422    | Too few rounds for the requested blocks (`details.maxWindows`)    |
| `robustness_too_large`          | 422    | Over the work limit                                               |
| `simulation_out_of_range`       | 422    | Exact results would leave the safe integer range                  |
| `robustness_failed`             | 500    | Computation, verification or storage failed; nothing was stored   |
| `stored_data_invalid`           | 500    | A stored analysis failed verification on read                     |

## User interface

Open a completed run and choose **Open robustness analysis** (`/simulations/:id/robustness`). The page shows:

- the caution above and the dataset identity (source, eligible rounds, exclusions, fingerprint);
- a form offering only the block counts the sample allows;
- for the selected analysis: its id, creation time, algorithm and format versions, the **full-sample** result, and a **block table** with each block's period, positions, round ids and summary;
- the saved analyses of the run, newest first, to reopen any of them.

## Tests

```bash
npx vitest run packages/shared/src/robustness.test.ts packages/shared/src/robustnessVerify.test.ts packages/shared/src/analysisProgression.test.ts
npx vitest run apps/server/test/robustness-api.test.ts apps/server/test/progression-analyses-api.test.ts
npx vitest run apps/web/test/robustness.test.tsx apps/web/test/progressionAnalyses.test.tsx
npm run check   # formatting, lint, typecheck, all tests, build
```

## Not included

- Configuration variants and parameter sensitivity (planned as a separate increment).
- Out-of-sample or walk-forward validation, which needs a pre-registered selection rule.
- Rolling or overlapping windows, calendar-based blocks and charts.
