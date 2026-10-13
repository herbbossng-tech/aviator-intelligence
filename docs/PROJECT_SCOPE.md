# Project scope

Aviator Intelligence is a local-first research and simulation dashboard for the crash-style game Aviator. This document records what exists, what is planned and what is excluded. Update it whenever scope changes.

## Principles

1. **Describe, simulate, and evaluate evidence, but keep the three apart.** Historical description, virtual simulation and verified predictive evidence are different things and are labelled differently in the UI and docs.
2. **No predictive claims.** Past multipliers are not presented as reliable predictors of future multipliers. Streak analysis, pattern detection or machine learning are not assumed to predict independent random outcomes.
3. **No profitability claims without evidence.** No strategy is described as guaranteed, winning or proven. Any future performance figures must come with variance, drawdown and uncertainty.
4. **No fabricated data.** Round history comes only from documented, permitted sources or manual entry. Synthetic data exists only as flagged test fixtures.
5. **Virtual money only.** All bankrolls, stakes and ledgers are simulated.

## Implemented now (foundation pass 1)

- npm workspace monorepo: `packages/shared`, `apps/server`, `apps/web`.
- Strict TypeScript, ESLint, Prettier, Vitest and a GitHub Actions CI workflow.
- Environment validation with safe defaults, plus refusal to bind to non-loopback hosts unless that is explicitly allowed.
- SQLite connection with foreign keys and WAL, a versioned transactional migration runner, and the initial schema:
  - `rounds`
  - `data_imports`
  - `strategies`
  - `simulation_runs`
  - `ledger_entries`
  - `schema_migrations`
- Exact numeric representation: money in integer minor units, multipliers as integer ×100.
- Zod schemas for:
  - the two-leg strategy configuration (legs A and B: enabled, label, stake, cashout target)
  - simulation settings
  - virtual risk stops
  - dataset selection
  - API contracts
- `settleLeg`: a deterministic, unit-tested accounting rule for one leg against one round.
- Read-only local API: `GET /api/health`, `/api/meta`, `/api/overview`, `/api/rounds`.
- Dashboard shell:
  - overview, round history, strategy lab (sample configuration, clearly labelled; replaced by the backtest form in pass 4), simulations, data sources, and methodology pages
  - honest empty and error states
  - a visible research/simulation-mode badge

## Implemented in pass 2: historical round data manager

- **One canonical round record** (`multiplier`, `sourceRoundId`, `eventAt`) and a single shared validation path used by CSV import, JSON import, manual entry (server) and the manual-entry form (client).
- **CSV and JSON import:**
  - fixed size and record limits
  - a preview stage that writes nothing
  - row-level errors with codes
  - single-use, expiring preview IDs, so confirmation never trusts client-sent records
- **Duplicate detection:**
  - (source, `sourceRoundId`) identity, enforced by a UNIQUE constraint
  - an in-file repeat and conflict policy
  - existing rounds are never overwritten
  - a content-hash guard against importing the same file twice
  - warnings only (never silent deduplication) for rounds without IDs
- **Transactional confirm:** the import row, its rounds and its counters commit together or not at all. Failed attempts are recorded as `failed` with zero records stored.
- **Import history** with accurate counters, enforced by database triggers.
- **Manual entry** with field-level errors, duplicate handling and protection against double submission.
- **Round browser** with filtering (source, ID search, multiplier range, import), sorting and pagination.
- **Docs and examples:** [DATA_IMPORT.md](DATA_IMPORT.md) and synthetic example files in [examples/](examples/).

## Implemented in pass 3: historical analytics

- **Shared analytics module** (`packages/shared/src/analytics.ts`), framework-free and unit-tested:
  - count, min, max and mean
  - nearest-rank quantiles (p25, p50, p75, p90, p95, p99)
  - empirical P(M ≥ t) for default or custom thresholds, with 95% Wilson score intervals
  - a histogram with explicit lower-inclusive, upper-exclusive bins and an open-ended tail
- **`GET /api/analytics`:** read-only, validated, and filterable by source, import, multiplier range and event-time range. It aggregates in SQLite, reports the denominator, coverage and exclusions explicitly, and never fabricates results.
- **Analytics page:** filters, summary cards, an accessible bar chart with a table view, the threshold table with intervals, a data-quality panel and interpretation notes.
- **Docs:** [ANALYTICS.md](ANALYTICS.md) documents every definition, method, edge case and limitation.
- **Deferred:** rolling-window summaries, because there is no trustworthy ordering for rounds without event times or across sources. See ANALYTICS.md.

## Implemented in pass 4: virtual simulation and historical backtesting

- **Engine** (`packages/shared/src/backtest.ts`): a pure, deterministic `runBacktest` over ordered rounds.
  - Each enabled leg is settled with `settleLeg`.
  - All money is integer minor units.
  - Policies for an insufficient bankroll: skip the leg, or stop the run.
  - Virtual stops: lower and upper bankroll stops, max drawdown in basis points, max rounds.
  - Reconciliation check: net = returned − staked.
- **Dataset rules:**
  - one source is required, optionally narrowed by import and event-time range
  - replay is by event time
  - undated rounds and synthetic fixtures are excluded and counted
  - duplicate or non-canonical event times are refused as unreliable
  - multiplier filters are not offered (look-ahead)
- **Persistence:** migration 003 (additive). Each run and its full ledger are written in one transaction. Other failures roll back and record a `failed` run with no ledger. Historical rounds are only read.
- **API:** dataset report, run, list, detail and paginated ledger (`/api/simulations…`).
- **UI:**
  - Strategy lab form with a dataset check and an assumptions review
  - Simulations list with side-by-side comparison of 2–4 runs
  - Run detail with summary, per-leg results, reproducibility hash, assumptions and ledger
- **Reproducibility:** the stored configuration and dataset report, plus a SHA-256 of the dataset's eligible rounds in replay order.
- **Docs:** [SIMULATION.md](SIMULATION.md).
- **Deferred:**
  - risk of ruin for a single backtest (no defensible estimate from one historical path; see pass 5 for the narrowly defined model frequency)
  - stored, named strategies (the `strategies` table is still unused; each run snapshots its configuration)

## Implemented in pass 5: simulation uncertainty and risk analysis

- **Engine:**
  - The backtest replay loop is now one internal core used by both `runBacktest` and resampled paths (`createSummaryReplayer`). There is no second settlement implementation.
  - `packages/shared/src/bootstrap.ts` adds a seeded **IID empirical bootstrap** of a completed run's own sample:
    - n draws with replacement per path; each path replayed independently from the starting bankroll with the run's configuration
    - xoshiro128\*\* per-path generators derived from (seed, path), with unbiased index draws
    - a recorded algorithm version
- **Statistics:**
  - nearest-rank quantiles (p05–p95, plus min and max) of ending bankroll, max drawdown (relative and amount) and rounds replayed
  - net-outcome and stop-reason counts, with denominators
  - the observed run beside the resampled figures
  - data-sufficiency warnings
  - **configured-boundary frequency**: the share of paths that ended by reaching the run's configured lower-bankroll or drawdown stop under the model. It is shown only when that stop is configured, and is explicitly not a probability of real-world ruin.
- **Safety:**
  - The sample must still match the run's dataset fingerprint (`409 dataset_changed` otherwise).
  - Limits are checked before computing: at most 2,000 paths and 1,000,000 replayed rounds per analysis.
  - Out-of-range results are refused rather than rounded.
- **Persistence:** migration 004 (additive). Only completed analyses are stored, as single rows that cannot be updated, tied to a completed run with the same fingerprint. Deleting a run cascades to them.
- **API:** `POST` and `GET /api/simulations/:id/analyses`, and `GET /api/simulations/:id/analyses/:analysisId`.
- **UI:** `/simulations/:id/uncertainty`, linked from each completed run.
- **Docs:** [UNCERTAINTY.md](UNCERTAINTY.md).
- **Deferred:**
  - block or stationary bootstrap (order-preserving)
  - confidence intervals for model frequencies
  - charts
  - background jobs for larger analyses

## Implemented in pass 6: strategy robustness (in progress)

- **Increment 1 — engine** (`packages/shared/src/robustness.ts`):
  - splits a run's eligible rounds into 2–10 contiguous, non-overlapping chronological blocks of near-equal size (at least 30 rounds each); boundaries depend only on the round count and order
  - replays the full sample and each block independently through the existing replay loop, each block starting again from the configured bankroll
  - validates options, limits, round order, canonical UTC event times, multipliers and configuration before any replay
- **Increment 2 — persistence, API and UI:**
  - strict result verification (`verifyBlockRobustnessResult`): versions, block count, partition boundaries, chronology, exact reconciliation, the source rounds at every boundary, and equality of the full-sample replay with the run's stored result
  - migration 005 (additive): `simulation_robustness_analyses`, single verified rows tied to a completed run with the same fingerprint; no updates; deletable; cascades with the run; algorithm and result-format versions recorded
  - API: `POST`, `GET` (paginated, filter by block count) and `GET`/`DELETE` one, under `/api/simulations/:id/robustness`; the server computes every result itself and re-checks the fingerprint inside the write transaction
  - UI: `/simulations/:id/robustness`, linked from each completed run
  - docs: [ROBUSTNESS.md](ROBUSTNESS.md)
- **Not included yet:** configuration variants (parameter sensitivity), out-of-sample or walk-forward validation, rolling windows, charts.

## In progress: staking progressions

- **Increment 1 — engine** (`packages/shared/src/progression.ts`): fixed, Martingale, capped Martingale and custom-sequence progressions as a pure, deterministic state machine with exact integer stakes, explicit step, stake, exposure and bankroll limits that block rather than bend, and result binding to each decision. See [PROGRESSION.md](PROGRESSION.md).
- **Increment 2 — backtest integration:** an optional per-leg staking plan for virtual backtests. Each leg progresses independently from its own results and is funded from the start-of-round bankroll (A, then B). An unfunded stake is skipped without counting as a loss or resetting the progression; permanent limits stop that leg for the rest of the run while the other continues. Auditable per-entry progression fields in the ledger and a per-leg progression summary. Additive migration 006 (old runs read as flat). Strategy lab mode selection (flat, fixed, Martingale, capped Martingale, custom) with validation, and progression details on the run page. See [SIMULATION.md](SIMULATION.md#staking-progressions).
- **Increment 3 — progression-aware analyses:** the uncertainty (IID bootstrap) and chronological robustness analyses replay a run's stored staking plan instead of refusing it.
  - Each resampled path, the full sample and each block start every progression afresh, and the policy is recorded in the result.
  - Per-leg results show how often a limit stopped the leg and how often the bankroll could not fund a stake.
  - Configuration snapshots include the plan, and stored analyses are checked against their run on every read.
  - No migration was needed, and flat-stake results are unchanged.
  - See [UNCERTAINTY.md](UNCERTAINTY.md#runs-with-a-staking-progression) and [ROBUSTNESS.md](ROBUSTNESS.md#runs-with-a-staking-progression).
- **Increment 4 — order-preserving block bootstrap:** a non-circular moving-block bootstrap for the uncertainty analysis, beside the unchanged IID bootstrap. See [BLOCK_BOOTSTRAP_DESIGN.md](BLOCK_BOOTSTRAP_DESIGN.md).
  - The design is complete and approved.
  - Step 1 (sampling primitives in `packages/shared/src/blockBootstrap.ts`, with deterministic tests) is implemented and committed locally on `feat/moving-block-bootstrap`.
  - Step 2 (the shared analysis engine `runBlockBootstrap` in `packages/shared/src/blockBootstrapAnalysis.ts`, replaying every path through the canonical replay loop) is implemented and committed locally on the same branch.
  - Step 3 (migration 007, block-analysis storage with read-time checks, and the `/api/simulations/:id/block-analyses` routes) is implemented and committed locally on the same branch.
  - Nothing for increment 4 is pushed, opened as a PR, merged or verified on `main`.
  - The UI (step 4) and the final review (step 5) are not started.
- A progression changes stake sizes only. It does not predict rounds, create an edge or guarantee recovery or profit; all amounts are virtual.

### Progression tracker

| Increment                                   | Implemented         | Tested      | Committed   | Pushed | Merged                  | Verified on `main`           |
| ------------------------------------------- | ------------------- | ----------- | ----------- | ------ | ----------------------- | ---------------------------- |
| 1 — progression engine                      | Yes                 | Yes         | Yes         | Yes    | Yes (PR #8, `79e7873`)  | Yes (CI passed on `79e7873`) |
| 2 — progressions in backtests               | Yes                 | Yes         | Yes         | Yes    | Yes (PR #9, `82d0644`)  | Yes (CI passed on `82d0644`) |
| 3 — progression-aware analyses              | Yes                 | Yes         | Yes         | Yes    | Yes (PR #10, `d8f5d4c`) | Yes (CI passed on `d8f5d4c`) |
| 4 — block bootstrap: design                 | Complete (approved) | —           | Yes (local) | No     | No                      | No                           |
| 4 — step 1: sampling primitives             | Yes                 | Yes (local) | Yes (local) | No     | No                      | No                           |
| 4 — step 2: shared analysis engine          | Yes                 | Yes (local) | Yes (local) | No     | No                      | No                           |
| 4 — step 3: storage and API (migration 007) | Yes                 | Yes (local) | Yes (local) | No     | No                      | No                           |
| 4 — step 4: UI                              | Not started         | No          | No          | No     | No                      | No                           |
| 4 — step 5: final review and PR             | Not started         | No          | No          | No     | No                      | No                           |

No pull request has been opened for increment 4.

Next required approval: the owner's review of the local step 3 implementation, and authorisation to begin step 4.

## Planned for later phases

Each phase needs separate approval.

- **Data:** editing or deleting stored rounds and imports (currently there is no delete or undo); exporting rounds.
- **Analysis:** rolling-window summaries, once a trustworthy within-source ordering is defined; per-source comparisons.
- **Strategy lab:** save and name two-leg strategies for reuse.
- **Simulation uncertainty, beyond pass 5:**
  - an order-preserving (block) bootstrap with a justified block length (being designed as progression increment 4; see [BLOCK_BOOTSTRAP_DESIGN.md](BLOCK_BOOTSTRAP_DESIGN.md))
  - interval estimates for model frequencies, with stated assumptions
- **Testing:** Playwright end-to-end tests of the dashboard itself.
- **Operations:** a combined production server for the built dashboard; backup/export tooling; an optional PostgreSQL migration path. The data access is already isolated in repository modules.

## Excluded from the current project scope

- Placing real-money bets, or automating staking or cashout on SportyBet or any other betting site.
- Logging in to betting accounts. Collecting or storing betting credentials, cookies, session tokens or browser storage state.
- Bypassing CAPTCHAs, authentication, rate limits or anti-bot controls.
- Reverse-engineering private endpoints or using unauthorised APIs.
- Connecting to a live betting session or modifying any account, balance or setting.
- Public hosting or deployment. This pass is local-only.
- Reusing code or architecture from any other project, including Tipstar.

## Live observation

Live observation of rounds is **not implemented** and is not in scope for any phase until it passes an explicit review. Real-money execution stays excluded regardless. The review must cover:

- the applicable platform terms
- whether an authorised data-access method exists
- technical feasibility
- security and privacy implications

See [LIVE_OBSERVATION_REVIEW.md](LIVE_OBSERVATION_REVIEW.md) for the questions that must be answered first. Research into permitted options may run alongside development, but it must not involve connecting to an account or a live session.
