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
  - duplicate event times are refused as ambiguous
  - multiplier filters are not offered (look-ahead)
- **Persistence:** migration 003 (additive). Each run and its full ledger are written in one transaction. Other failures roll back and record a `failed` run with no ledger. Historical rounds are only read.
- **API:** dataset report, run, list, detail and paginated ledger (`/api/simulations…`).
- **UI:**
  - Strategy lab form with a dataset check and an assumptions review
  - Simulations list with side-by-side comparison of 2–4 runs
  - Run detail with summary, per-leg results, reproducibility hash, assumptions and ledger
- **Reproducibility:** the stored configuration and dataset report, plus a SHA-256 of the replayed rounds.
- **Docs:** [SIMULATION.md](SIMULATION.md).
- **Deferred:**
  - risk of ruin (no defensible estimate from one historical path)
  - resampling and uncertainty intervals for backtests
  - stored, named strategies (the `strategies` table is still unused; each run snapshots its configuration)

## Planned for later phases

Each phase needs separate approval.

- **Data:** editing or deleting stored rounds and imports (currently there is no delete or undo); exporting rounds.
- **Analysis:** rolling-window summaries, once a trustworthy within-source ordering is defined; per-source comparisons.
- **Strategy lab:** save and name two-leg strategies for reuse.
- **Simulation uncertainty:** seeded resampling (e.g. block bootstrap) with stated assumptions, which could support uncertainty intervals and a defensible risk-of-ruin estimate.
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
