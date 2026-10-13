# Staking progressions (fixed, Martingale, capped Martingale, custom)

`packages/shared/src/progression.ts` models **virtual** staking progressions as a pure, deterministic state machine. This first increment is a domain engine only: it is **not yet connected** to the historical backtester, the API, the database or the UI.

> **Read this first.**
>
> - The engine never predicts a round. It says which stake a configuration requests next, and records a win or loss that the **caller** observed or simulated.
> - A Martingale cannot guarantee recovery or profit. Stakes grow geometrically, so a run of losses quickly reaches a stake limit, an exposure limit or the bankroll. The engine then **stops**: it never lowers a stake, raises a cap or resets a losing cycle to keep going.
> - Results from historical replays are not evidence of future profitability.
> - Virtual money only. Nothing is placed anywhere.

## Modes

| Mode                | Stake at step k                                | Required limits                      |
| ------------------- | ---------------------------------------------- | ------------------------------------ |
| `fixed`             | the base stake, always (a comparison baseline) | `maxSteps`                           |
| `martingale`        | `ceil(base × m^k / 100^k)`                     | `maxSteps`, `maxCycleExposureMinor`  |
| `capped_martingale` | `ceil(base × m^k / 100^k)`                     | `maxSteps`, `maxStakeMinor`          |
| `custom`            | `stakesMinor[k]`                               | the sequence length (1 to 100 steps) |

- `m` is the progression multiplier as an integer ×100, from 101 (1.01×) to 1,000 (10.00×). For example, 200 doubles the stake.
- Every mode also accepts the optional limits it does not require: `maxStakeMinor` and `maxCycleExposureMinor` are `null` when unused.
- `maxSteps` is from 1 to 1,000.

### Configuration contract

All schemas are strict: unknown fields are rejected.

```ts
{
  schemaVersion: 1,
  currency: 'NGN' | 'USD' | 'GBP' | 'EUR',
  winResetPolicy: 'reset_to_base',
  mode: 'martingale',
  baseStakeMinor: 50_000,          // ₦500.00 in kobo
  multiplierX100: 200,             // 2.00x
  limits: { maxSteps: 6, maxStakeMinor: null, maxCycleExposureMinor: 3_150_000 },
}
```

A custom sequence uses `stakesMinor` (positive integers, at most 100 entries) and `afterFinalStep: 'stop'` instead of `baseStakeMinor` and `multiplierX100`. Its base stake is `stakesMinor[0]`.

A configuration is also rejected if its base stake is already blocked by one of its own caps, so a configuration can always place at least one stake.

## Steps, cycles and state

- **Steps are zero-based.** Step 0 is the base stake. Step k is the stake after k consecutive losses in the current cycle, so `step` is also the number of consecutive losses.
- **Cycles.** A cycle starts at step 0 and ends with a win. The only win policy is `reset_to_base`: back to step 0, with the cycle's losses cleared.
- **Cycle losses.** `cycleLossMinor` is the sum of the stakes lost in the current cycle. It is never negative and always equals the sum of the stakes of steps 0 to step − 1; parsing a state checks this exactly.

### State fields

The state is plain JSON and is validated by `parseProgressionState(config, state)`.

| Field             | Meaning                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `configKey`       | Deterministic FNV-1a 64-bit key of the configuration's canonical JSON. It guards against continuing under different settings by accident; it is not a cryptographic hash. |
| `status`          | `ready`, `awaiting_result`, `blocked` or `exhausted`                                                                                                                      |
| `step`            | Zero-based step of the next or pending stake                                                                                                                              |
| `cycleLossMinor`  | Losses so far in this cycle                                                                                                                                               |
| `cyclesCompleted` | Wins so far                                                                                                                                                               |
| `resolvedCount`   | Wins plus losses recorded                                                                                                                                                 |
| `pendingDecision` | `{ decisionId, stakeMinor }` while awaiting a result; `decisionId` equals `resolvedCount`                                                                                 |
| `blockReason`     | Set only when `blocked`; it must be the reason the configuration actually implies                                                                                         |

A state whose fields disagree with each other or with its configuration is rejected. It is never repaired.

## API

| Function                                                     | Purpose                                                                    |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `parseProgressionConfig(input)`                              | Validates a configuration (throws `ProgressionError('invalid_config')`).   |
| `progressionConfigKey(config)`                               | The deterministic configuration key.                                       |
| `createProgressionState(config)`                             | A fresh state: step 0, no results.                                         |
| `decideNextStake(config, state, { availableBankrollMinor })` | Returns a `stake`, `blocked` or `exhausted` decision, with the next state. |
| `resolveStake(config, state, { decisionId, outcome })`       | Records `'win'` or `'loss'` for the pending decision.                      |
| `parseProgressionState(config, state)`                       | Validates a stored state against its configuration.                        |
| `martingaleStakeMinor(base, multiplierX100, step)`           | The exact stake formula on its own.                                        |
| `cycleNetAfterWinMinor(stake, cashoutTargetX100, priorLoss)` | Cycle net if this stake wins at its target (see below).                    |

Every function is pure: it never mutates its inputs, and nothing depends on time, randomness or hidden state. The same inputs always give the same outputs.

### Decisions and resolutions

- **Separate steps.** Deciding a stake and recording its result are separate calls, so the engine never invents a result.
- **Binding a result to its decision.** A `stake` decision carries a `decisionId`, and `resolveStake` requires that exact id. This means a result cannot be:
  - recorded twice;
  - recorded without a pending decision;
  - recorded against a stale decision;
  - recorded under a different configuration.
- **One decision at a time.** While a decision is pending, `decideNextStake` refuses to issue another (`decision_pending`).
- **On a loss:** the stake is added to the cycle's losses, and the progression moves forward one step.
- **On a win:** the cycle ends, `cycleLossMinor` returns to 0, and the next stake is the base stake.

## Limits and blocked decisions

`decideNextStake` checks, in this order:

1. **Step limit.** At `maxSteps` the decision is `blocked` with reason `max_steps_reached`. A custom sequence is instead `exhausted` (`sequence_exhausted`): after a loss on its final step there is no further stake, and the sequence is never extended.
2. **Maximum stake.** If the next stake is above `maxStakeMinor`, the reason is `max_stake_exceeded`.
3. **Cycle exposure.** If the cycle's losses plus the next stake would exceed `maxCycleExposureMinor`, the reason is `cycle_exposure_exceeded`.
4. **Bankroll.** If the next stake is above the virtual bankroll supplied for this decision, the reason is `insufficient_bankroll`. The bankroll is only read, never changed.

These outcomes are deliberately distinct:

- A **blocked** decision reports the stake that was requested (`requestedStakeMinor`). It never offers a smaller one.
- **Blocked and exhausted states are terminal.** Asking again returns the same decision, even with a larger bankroll. The progression must not continue past a limit.
- **Invalid configurations, states and inputs** throw `ProgressionError` with a machine-readable code: `invalid_config`, `invalid_state`, `config_mismatch`, `invalid_input`, `decision_pending`, `no_pending_decision` or `decision_mismatch`.

## Exact arithmetic and rounding

- **Integer money.** Amounts are integer minor units: ₦500.00 is 50,000 kobo. Multipliers are integers ×100.
- **Martingale stakes** are computed in closed form, `ceil(base × m^k / 100^k)`, with BigInt:
  - each step is computed exactly from the base, and rounded **up** once, so a stake never understates the configured requirement;
  - rounding is not compounded from step to step.
  - Examples: base 333 at 1.50× gives 333, 500, 750, 1,124; base 1 at 2.10× gives 1, 3, 5, 10.
- **Range.** A stake above 10¹² minor units is never produced. Because the required caps are themselves at most 10¹², a cap always blocks first. The configuration schema also checks every reachable step, as a defensive measure.
- **No float overflow.** Intermediate products such as 999¹² are exact BigInts and are converted back to numbers only after range checks.

## Illustrative example (arithmetic only, not a recommendation)

Base stake ₦500, multiplier 2.00×, six steps:

| Step | Stake   | Cycle losses if this stake also loses |
| ---- | ------- | ------------------------------------- |
| 0    | ₦500    | ₦500                                  |
| 1    | ₦1,000  | ₦1,500                                |
| 2    | ₦2,000  | ₦3,500                                |
| 3    | ₦4,000  | ₦7,500                                |
| 4    | ₦8,000  | ₦15,500                               |
| 5    | ₦16,000 | ₦31,500                               |

- If all six stakes lose, the cycle has lost **₦31,500**, and the progression is blocked at step 6.
- A seventh stake would have been ₦32,000.

## Net of a winning cycle

If a stake s wins at cashout target c, after earlier losses L in the same cycle, the cycle's net is:

> **s × (c − 1) − L**

This applies under the backtest's gross-return model, where the gross return is `floor(s × c / 100)` in minor units with c ×100, and it includes the returned stake.

- `cycleNetAfterWinMinor` computes it exactly as `floor(s × c / 100) − s − L`. This equals s × (c − 1) − L whenever s × c is a whole number of minor units.
- **Example:** ₦16,000 winning at 2.00× after ₦15,500 of losses nets ₦500.
- **Below 2.00×, a win can still leave the cycle negative.** For example, ₦4,000 winning at 1.50× after ₦3,500 of losses nets −₦1,500.
- **Assumptions:** the target is reached, and there are no fees or platform deductions. It says nothing about whether the win is likely, affordable, or reached before a limit blocks the progression.

## Not included yet

- Using progressions in the historical backtester, robustness or uncertainty analyses.
- API, persistence and UI.
- Win policies other than `reset_to_base`.
- Recovery-target or other stake-sizing algorithms.

## Tests

```bash
npx vitest run packages/shared/src/progression.test.ts
npm run check
```
