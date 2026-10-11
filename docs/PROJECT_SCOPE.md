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
  - overview, round history, strategy lab (sample configuration, clearly labelled), simulations, data sources, and methodology pages
  - honest empty and error states
  - a visible research/simulation-mode badge

## Planned for later phases

Each phase needs separate approval.

- **Data:** CSV/JSON round import with per-row validation and rejection reporting; manual round entry; import audit trail.
- **Analysis:** multiplier distribution analysis (empirical CDF, survival function P(M ≥ t), confidence intervals); Recharts visualisations.
- **Strategy lab:** create, edit and store two-leg strategies (config validated by the shared schema).
- **Simulation engine:** reproducible backtests over a selected dataset, persistent virtual ledger, virtual risk stops (stop-loss, take-profit, max drawdown, max rounds), and seeded resampling (e.g. bootstrap) for uncertainty.
- **Comparison:** side-by-side metrics for configurations, always with variance, drawdown, risk of ruin and uncertainty intervals.
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
