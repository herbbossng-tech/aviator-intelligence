# Virtual simulation and historical backtesting

Pass 4 replays stored historical rounds against a configured two-leg strategy, using a **virtual** bankroll. This document defines exactly what a backtest does, what it reports and what it cannot tell you.

> **Virtual money only.** Nothing is placed, staked or cashed out anywhere. A backtest replays recorded rounds; it does not predict future multipliers. A positive result is not evidence that a configuration will be profitable. Crash-game rounds are designed to be independent of earlier rounds.

## Where the code lives

| Part                       | Location                                                                         |
| -------------------------- | -------------------------------------------------------------------------------- |
| Engine (pure, no I/O)      | `packages/shared/src/backtest.ts` (`runBacktest`)                                |
| Settlement rule            | `packages/shared/src/simulation.ts` (`settleLeg`)                                |
| API schemas                | `packages/shared/src/backtest.ts`                                                |
| Dataset report, run writes | `apps/server/src/db/repositories/simulations.ts`, `apps/server/src/simulations/` |
| Schema changes             | `apps/server/src/db/migrations/003_simulation_backtests.ts`                      |
| HTTP routes                | `apps/server/src/http/routes/simulations.ts`                                     |
| UI                         | Strategy lab (`/strategy-lab`), Simulations (`/simulations`, `/simulations/:id`) |

## Configuration

**Strategy** (`twoLegStrategyConfigSchema`): two legs, A and B. Each leg has:

- `enabled`
- `label` (1–40 characters)
- `stakeMinor`: a positive integer in minor units (for example kobo), at most 10^12
- `cashoutTargetX100`: an integer ×100, from 101 (1.01x) to 100,000,000

At least one leg must be enabled. Nothing is hard-coded: the 2.00x and 6.00x values in the Strategy lab are editable placeholders from the illustrative sample configuration.

**Settings** (`simulationSettingsSchema`):

- `startingBankrollMinor`: a positive integer
- `insufficientBankrollPolicy`: `skip_leg` or `stop_run`
- risk stops, each optional:
  - `stopBelowBankrollMinor`: must be below the start
  - `stopAtOrAboveBankrollMinor`: must be above the start
  - `maxDrawdownBps`: 1–10,000 basis points
  - `maxRounds`

The request is also cross-checked:

- the strategy and settings use the same currency
- every enabled stake is no larger than the starting bankroll
- under `stop_run`, the combined stakes are no larger than the starting bankroll (otherwise the run could never place a round)

The Strategy lab accepts amounts in major units ("500", "1,250.50"). It converts them to integer minor units with string arithmetic (`parseMajorAmountToMinor`), never through floating point.

## Dataset selection and ordering

A backtest replays rounds in a sequence, so the order must be trustworthy.

- **One source is required.** Rounds from different sources cannot be merged into one reliable sequence.
- **Optional narrowing:** an import number, and an event-time range `[eventFrom, eventTo)`. Times are ISO-8601 with an explicit offset and are normalised to UTC.
- **No multiplier filters.** Selecting rounds by their own outcome would leak results into the selection (look-ahead bias). The API rejects these parameters.
- **Eligible rounds** are non-synthetic rounds of the source (and import), with an event time inside the range.
- **Ordering rule:** replay by `event_at` ascending.
  - Rounds without an event time are **excluded and counted**. The app never invents timestamps, and insertion order is not treated as event order.
  - If two eligible rounds share an event time, the order is ambiguous and the run is **refused** (HTTP 422) until the selection is narrowed.
  - Event times are ordered as text, which is only correct for the canonical UTC form the app writes (`YYYY-MM-DDTHH:MM:SS.sssZ`). Each stored value must also be a real instant: it must equal `new Date(value).toISOString()`, so impossible values with the right shape (`2026-02-30…`, a 29 February outside a leap year, hour 24, second 60) are rejected. If any eligible round has an event time that fails this check (for example, edited outside the app), the run is **refused** with 422 before anything is stored, and the count is shown as `nonCanonicalEventTimes`.
  - A selection with no eligible rounds is refused.
  - A selection with more than 100,000 eligible rounds is refused.
- **Synthetic test fixtures** (`is_synthetic = 1`) are always excluded and counted.

`GET /api/simulations/dataset` returns this report without running anything. The Strategy lab shows it under **Check dataset**, and every stored run keeps the report.

## Replay model

For each eligible round, in order:

1. **Pre-round stops.** These use only the configuration and the bankroll so far.
   - `maxRounds` reached → stop (`max_rounds`).
   - The bankroll is below the smallest stake requested this round by an enabled leg → stop (`bankroll_exhausted`). A flat leg always requests its configured stake; a progression leg requests its current step's stake (see [Staking progressions](#staking-progressions)). A progression leg stopped by a permanent limit requests nothing, and if no leg requests anything this check does not apply.
   - Under `stop_run`, the bankroll is below the sum of the requested stakes → stop (`insufficient_bankroll`).
2. **Stake the enabled legs**, A then B, from the bankroll available at the start of the round.
   - Under `skip_leg`, a leg that cannot be funded is recorded as `skipped` with zero stake. Leg B is funded only from what is left after leg A's stake; neither leg can use winnings from the same round.
   - Disabled legs produce no ledger entry.
3. **Settle each placed leg** with `settleLeg`:
   - The leg reaches its target when the round's crash multiplier M ≥ target T. (This is a modelling assumption still to be confirmed against the platform's published rules.)
   - **Gross return** = ⌊stake × T / 100⌋ minor units, computed exactly with BigInt (stake × T can exceed 2^53 even when the return does not). This includes the returned stake.
   - Otherwise the gross return is 0.
   - **Net** = gross − stake.
4. **Update the bankroll:** bankroll after = bankroll before + sum of leg nets. It can never go negative, because no stake can exceed the funds available.
5. **Post-round stops**, which take effect before the next round:
   - the bankroll is below the lower stop (`stop_below`)
   - the bankroll is at or above the upper stop (`stop_at_or_above`)
   - the drawdown from the running peak is at or above `maxDrawdownBps` (`max_drawdown`; compared exactly in integer arithmetic)

If none of these stops triggers, the stop reason is `completed_all_rounds`.

**No look-ahead:** a round's multiplier is used only to settle that round. A test checks this by appending rounds and confirming that the earlier ledger is unchanged.

All money arithmetic uses integers. Running totals are accumulated as exact BigInts. The engine checks, exactly, that:

- for every leg entry, net = gross − stake
- for every leg, net = returned − staked, and wins + losses = placed
- for the run, `ending − starting = total returned − total staked`

**Range limit.** The API returns amounts as JSON numbers, which are exact only up to `Number.MAX_SAFE_INTEGER` (about 9.007 × 10^15 minor units). If any return, bankroll or total would exceed that, the run is **refused** with HTTP 422 `simulation_out_of_range`, and nothing is stored. Results are never reported rounded. In practice this takes stakes near the 10^12 maximum held over thousands of rounds, or targets in the hundreds of thousands of x.

## Staking progressions

By default every enabled leg stakes its configured `stakeMinor` every round ("flat" stakes). A request may add an optional **staking plan** that gives either leg, or both, a progression from [PROGRESSION.md](PROGRESSION.md): fixed, Martingale, capped Martingale or a custom sequence.

> **Read this first.** This is virtual-money research tooling. Historical results do not predict future rounds. A Martingale or any other progression only changes stake sizes: it does not create a predictive edge, and no strategy guarantees recovery of losses or profitability. Live betting and real-money execution are not implemented.

```json
"staking": {
  "schemaVersion": 1,
  "legs": {
    "A": { "schemaVersion": 1, "currency": "NGN", "winResetPolicy": "reset_to_base",
           "mode": "martingale", "baseStakeMinor": 50000, "multiplierX100": 200,
           "limits": { "maxSteps": 4, "maxStakeMinor": null, "maxCycleExposureMinor": 1000000 } },
    "B": null
  }
}
```

**Contract.**

- `staking` is optional. Omitted or `null` means flat stakes for both legs, exactly as before; a `null` leg is flat.
- A progression may only be given to an **enabled** leg, in the strategy's currency, and must **start at the leg's own stake** (`baseStakeMinor`, or the first custom stake, equals the leg's `stakeMinor`). Anything else is refused with 400 `validation_error` and a `staking.legs.<leg>` path.
- The progression schemas and limits are those of [PROGRESSION.md](PROGRESSION.md); every configuration is validated in full before any round is replayed.

**Independence.** Each leg has its own progression state (step, cycle loss, cycles completed). A leg's step changes only on that leg's own win or loss: a win resets it to step 0, a loss moves it one step up. One leg's result never changes the other leg's step, and a leg cannot use the other leg's same-round winnings, because both are funded from the bankroll at the start of the round, A first.

**Each round, for each enabled leg in order A, B**, before the round's multiplier is read:

1. The progression states what it **requests** — the stake for its current step — or that it is stopped by a permanent limit.
2. The pre-round stops above use the requested stakes.
3. A requested stake that the remaining start-of-round funds cover is **placed in full** and settled with `settleLeg`. It is never lowered, split or capped to fit.
4. A requested stake that cannot be funded is a **transient skip** under `skip_leg`: the entry is `skipped` with zero stake, `skipReason = "insufficient_bankroll"` and the requested amount in `requestedStakeMinor`. **A skip is not a loss**: the leg's step and cycle loss are unchanged, it does not reset, it is not added to losses or to staked totals, and the same stake is requested again next round.
5. Under `stop_run`, the run instead stops before the round (`insufficient_bankroll`) when the bankroll is below the sum of requested stakes, as for flat legs.

**Permanent limits.** When a leg's next stake would break its step limit (`max_steps_reached`), maximum stake (`max_stake_exceeded`) or maximum cycle exposure (`cycle_exposure_exceeded`), or a custom sequence has no further step (`sequence_exhausted`), that leg **stops for the rest of the run**. Limits are never bypassed: the stake is not lowered, the cap is not raised, and the cycle is not reset to continue. From then on the leg records a `skipped` entry each round with that reason and `active = false`, so the ledger shows why it placed nothing. **The other leg continues** with its own stakes. If every enabled leg is stopped, the remaining rounds are replayed without stakes (counted in `summary.progression.roundsWithoutStake`, break-even rounds); the stop reason stays `completed_all_rounds` unless another stop applies. A stop reason was deliberately not added for this, because the stored stop reasons are fixed by a database constraint that cannot be changed additively.

**Session stops** (`stop_below`, `stop_at_or_above`, `max_drawdown`, `max_rounds`) keep their meaning and apply to the whole bankroll, whatever the legs' progressions are doing.

**Ledger.** For a progression leg, each entry adds a `progression` object; flat legs and runs without a plan have none, and their ledgers are identical to before.

| Field                  | Meaning                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `step`                 | Zero-based step at decision time                                                                                                                                                |
| `requestedStakeMinor`  | What the progression asked for; `null` once it is stopped by a limit. `stakeMinor` stays the stake actually placed (0 when skipped); a requested stake is never shown as placed |
| `cycleLossBeforeMinor` | Losses in the leg's current cycle before this round                                                                                                                             |
| `cycleLossAfterMinor`  | After this round: 0 after a win, + stake after a loss, unchanged after a skip                                                                                                   |
| `skipReason`           | `null` when placed; otherwise `insufficient_bankroll` or the permanent limit                                                                                                    |
| `active`               | `false` once a permanent limit has stopped the leg                                                                                                                              |

**Summary.** With a plan, `summary.progression` reports per leg: mode, configuration key (FNV-1a 64-bit of the canonical configuration), final status (`active`, `blocked`, `exhausted`) and block reason, final step and open cycle loss, highest step placed, completed (won) cycles, skips for insufficient bankroll, skips after a permanent stop, and the round from which the leg was stopped. Per-leg `skipped` counts include both kinds of skip; per-leg `stakeMinor` remains the configured (base) stake. Runs without a plan have no `progression` field.

**Analyses.** Runs with a staking plan can be analysed like any other. The uncertainty analysis replays the stored plan on every resampled path, and the robustness analysis replays it on the full sample and on every block. Each path and each block starts every progression afresh. See [UNCERTAINTY.md](UNCERTAINTY.md#runs-with-a-staking-progression) and [ROBUSTNESS.md](ROBUSTNESS.md#runs-with-a-staking-progression).

## Reported metrics

All amounts are virtual, in minor units, shown in major units in the UI.

| Metric                           | Definition                                                                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Starting / ending bankroll       | Before the first round / after the last replayed round                                                                                                         |
| Total staked                     | Sum of stakes actually placed (skipped legs stake 0)                                                                                                           |
| Total returned                   | Gross paid back on successful cashouts, **including stakes**                                                                                                   |
| Net                              | `returned − staked` = `ending − starting`                                                                                                                      |
| Return on starting bankroll      | `net / starting` (for example −0.25 means a quarter of the starting bankroll was lost)                                                                         |
| Rounds replayed / not replayed   | Out of the eligible rounds; "not replayed" is non-zero only when a stop ended the run early                                                                    |
| Stop reason                      | Why the replay ended (see above)                                                                                                                               |
| Rounds with profit / loss / even | Round net > 0, < 0, = 0; the profitable share uses **rounds replayed** as its denominator                                                                      |
| Per leg: placed, wins, losses    | `wins + losses = placed`; the win rate (`wins / placed`) uses **placed** as its denominator                                                                    |
| Per leg: skipped                 | Rounds where the leg was enabled but could not be funded                                                                                                       |
| Per leg: staked / returned / net | As above, for one leg                                                                                                                                          |
| Peak / lowest bankroll           | Highest / lowest end-of-round bankroll, including the starting bankroll                                                                                        |
| Max drawdown (amount)            | Largest fall from a running peak to a later end-of-round bankroll, in minor units                                                                              |
| Max drawdown (% of running peak) | Largest value of (peak − bankroll) / peak over the run; the same quantity the drawdown stop uses. It can come from a different episode than the largest amount |
| Longest losing streak            | Most consecutive rounds with a negative round net (a break-even round ends a streak)                                                                           |

**Risk of ruin is not reported for a backtest.** A single historical path gives one realisation, not a distribution. Max drawdown and lowest bankroll describe this replay only. A completed run can be resampled with the separate uncertainty analysis ([UNCERTAINTY.md](UNCERTAINTY.md)). That analysis reports how often resampled paths reached a _configured_ boundary under a stated bootstrap model. This is a narrowly defined model frequency, not an unconditional probability of ruin.

## Persistence and failure handling

- **Migration 003** is additive. It adds:
  - to `simulation_runs`: `summary_json`, `stop_reason` and `dataset_sha256`
  - to `ledger_entries`: `round_multiplier_x100` and `bankroll_before_minor`

  Triggers enforce these rules:
  - a completed run must carry a summary, a stop reason and a dataset hash
  - a non-completed run may not carry a summary
  - ledger rows may only belong to a completed run
  - stored ledger rows are immutable: they cannot be updated, and cannot be deleted while their run exists. Deleting the run itself still cascades to its whole ledger.
  - a completed run cannot change to another status

- **Migration 006** is additive. It adds `simulation_runs.staking_json` (the staking plan; NULL for flat runs and for every run stored before it) and six nullable progression columns on `ledger_entries` (`progression_step`, `requested_stake_minor`, `cycle_loss_before_minor`, `cycle_loss_after_minor`, `skip_reason`, `progression_active`). Existing rows are not rewritten: they keep NULLs, which mean flat stakes. Triggers forbid changing a stored plan and reject progression fields that are inconsistent with each other or with the entry's result, or that appear on a run without a plan. Reading a run validates the stored plan and each entry's progression fields against it; anything malformed is reported as 500 `stored_data_invalid` rather than shown.

- **One transaction:** reading the dataset, replaying it, and writing the completed run with **every** ledger entry commit together or not at all.
- **Refused requests:** a selection that cannot be ordered, and a run whose exact results would leave the supported integer range, are rejected with 422, and nothing is stored.
- **Other failures:** the transaction rolls back. A separate `failed` run is recorded with a generic message, no summary and no ledger. Internal details are only logged. A failed run is never shown as completed, and the Overview's virtual bankroll only uses completed runs.
- **Historical rounds are read-only.** They are never modified by a backtest, and ledger rows reference them with `ON DELETE RESTRICT`.

## Reproducibility

Each run stores:

- the exact strategy and settings
- the dataset request and the resolved dataset report
- `dataset_sha256`: SHA-256 over a canonical encoding of the dataset's eligible rounds, in replay order. It covers every eligible round, including any that an early-stopped replay never reached:

  ```
  aviator-intelligence/backtest-dataset/v1\n
  <source as a JSON string>\n
  [roundId, sourceRoundId, multiplierX100, eventAt] as a JSON array, one line per round\n
  ```

  JSON escaping means no field value can be mistaken for a separator. A change to the source, a round's identity, its multiplier, its event time or the set or order of rounds changes the hash.

The dataset fingerprint covers only the rounds, so it is the same for flat and progression runs over the same data. The configuration is identified separately: every stored run keeps its exact strategy, settings and staking plan (`staking_json`, every progression setting included), and the summary records each progression's configuration key.

The fingerprint identifies the data representation that was hashed. It does not prove that the data is authentic or complete.

The engine has no randomness. Re-running the same configuration over the same stored rounds gives the same hash, summary and ledger. Tests check this through the API.

## API

| Method and path                   | Purpose                                                                  |
| --------------------------------- | ------------------------------------------------------------------------ |
| `GET /api/simulations/dataset`    | `source` (required), `importId`, `eventFrom`, `eventTo` → dataset report |
| `POST /api/simulations`           | `{ strategy, settings, dataset, staking? }` → 201 with the stored run    |
| `GET /api/simulations`            | `limit` (≤ 100), `offset` → runs, newest first                           |
| `GET /api/simulations/:id`        | One run (`id` must be a plain decimal integer)                           |
| `GET /api/simulations/:id/ledger` | `limit` (≤ 500), `offset` → ledger grouped by replayed round             |

Error codes:

- `validation_error` (400): an invalid or unknown field
- `dataset_not_replayable` (422): the details include the dataset report
- `simulation_out_of_range` (422): exact results would exceed `Number.MAX_SAFE_INTEGER`; nothing is stored
- `simulation_failed` (500): generic; a failed run is recorded
- `simulation_not_found` (404)
- `stored_data_invalid` (500): a stored run could not be read back safely (for example, a row written outside the app). The details give the run id only. The row is not modified or skipped, and the cause is logged on the server.

The routes sit behind the same loopback Host guard as the rest of the API.

## Limitations

- The settlement rule (M ≥ T, rounded down) has not been confirmed against the platform's published rules.
- The replay ignores anything the recorded data cannot show: timing, latency, manual cashouts, platform limits, and whether a cashout would actually have been accepted.
- A backtest over one historical sequence says nothing about the distribution of outcomes on other sequences. The optional uncertainty analysis ([UNCERTAINTY.md](UNCERTAINTY.md)) resamples the same observations under an IID bootstrap model. It does not add new information, and it does not report confidence intervals. The optional robustness analysis ([ROBUSTNESS.md](ROBUSTNESS.md)) replays separate chronological periods of the same data; those periods are in-sample, not out-of-sample validation.
- Selections larger than 100,000 eligible rounds must be narrowed.
- Staking progressions: only the `reset_to_base` win policy; progressions are configured per run (configurations are not yet saved for reuse).
- `limit`, `offset` and `importId` query parameters use the same lenient number parsing as the rest of the API (for example `1e1` is read as 10). Run ids in the path are strict. Making query parsing strict across every endpoint is deferred.
