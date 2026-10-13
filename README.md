# Aviator Intelligence

A local-first web dashboard for **researching** the crash-style game Aviator. It records historical rounds with their source, describes them statistically, and replays them as **virtual** backtests of strategy configurations (two independently configured legs, such as different cashout targets), with honest reporting of risk.

> **Research and simulation only.**
>
> - No strategy in this project is claimed or guaranteed to be profitable.
> - Past multipliers are not treated as predictors of future multipliers.
> - Live betting, real-money execution, account login and browser automation of betting sites are **not implemented**.
> - All bankroll figures are virtual.

## Current status

Foundation pass 1, **pass 2 (historical round data manager)**, **pass 3 (historical analytics)**, **pass 4 (virtual simulation and historical backtesting)** and **pass 5 (simulation uncertainty analysis)** are implemented. See [docs/PROJECT_SCOPE.md](docs/PROJECT_SCOPE.md) for the full implemented / planned / excluded breakdown.

| Area                                                                                                                      | Status                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| npm workspace (shared / server / web), strict TypeScript                                                                  | Done                                                                                             |
| SQLite database, versioned migrations, initial domain schema                                                              | Done                                                                                             |
| Validated two-leg strategy config and simulation settings                                                                 | Done                                                                                             |
| Leg settlement accounting rule (`settleLeg`), unit-tested                                                                 | Done                                                                                             |
| Local API: health, meta, overview, rounds (read + manual entry), imports                                                  | Done                                                                                             |
| Dashboard shell with honest empty states                                                                                  | Done                                                                                             |
| Tests (Vitest + React Testing Library), ESLint, Prettier, CI workflow                                                     | Done                                                                                             |
| Round data manager: manual entry, CSV/JSON import with preview, duplicate detection, import history, filtering            | Done (pass 2)                                                                                    |
| Virtual backtests: two-leg engine, dataset ordering checks, persistent ledger, run comparison                             | Done (pass 4)                                                                                    |
| Historical analytics: summary, nearest-rank quantiles, P(M ≥ t) with 95% Wilson intervals, histogram, data-quality report | Done (pass 3)                                                                                    |
| Uncertainty analysis of backtests: seeded IID bootstrap, quantiles, configured-boundary frequency                         | Done (pass 5)                                                                                    |
| Chronological robustness analysis of backtests: independent replays of consecutive periods, stored and verified           | Done (pass 6)                                                                                    |
| Playwright browser tests of the dashboard                                                                                 | Planned                                                                                          |
| Live observation                                                                                                          | Out of scope until reviewed ([docs/LIVE_OBSERVATION_REVIEW.md](docs/LIVE_OBSERVATION_REVIEW.md)) |
| Real-money execution / betting automation                                                                                 | Excluded                                                                                         |

## Round data

Rounds can be added in two ways:

- **Manual entry** (Round data → Add a round)
- **CSV or JSON import** (Round data → Import file)

Both use the same validation:

- Multipliers are stored exactly, with at most two decimals and a minimum of 1.00x.
- Event times must include a time zone.
- Every round carries the source label you declare.

Imports are validated and previewed before anything is stored. They are committed in one transaction and recorded in the import history.

Rounds with a source round ID are never stored twice for the same source, and existing rounds are never overwritten. Rounds without IDs are never silently deduplicated.

**Analytics** (`/analytics`, `GET /api/analytics`) describe the stored rounds you select:

- count, mean, median and quantiles
- min and max
- the observed share at or above chosen thresholds, each with its denominator and a 95% Wilson interval
- a histogram of counts per multiplier bin
- a data-quality report

These figures describe historical records only; they do not predict the next multiplier or show that any strategy is profitable. Definitions and methods are in **[docs/ANALYTICS.md](docs/ANALYTICS.md)**.

**Backtests** (Strategy lab → Simulations, `/api/simulations`) replay the stored rounds of one source in event-time order against a configured two-leg strategy and a virtual bankroll:

- rounds without an event time and synthetic fixtures are excluded and counted; ambiguous ordering is refused
- each run and its full ledger are stored in one transaction; failed runs are recorded as failed with no ledger
- results include staked, returned (gross) and net, return on the starting bankroll, per-leg wins and losses with denominators, max drawdown, lowest bankroll and longest losing streak
- a SHA-256 of the dataset's eligible rounds (in replay order) makes reruns verifiable

Backtests use virtual money only and do not predict future rounds. The method is in **[docs/SIMULATION.md](docs/SIMULATION.md)**.

**Uncertainty analysis** (from a completed run, or `/api/simulations/:id/analyses`) resamples that run's own observed multipliers with a seeded IID bootstrap and replays the same configuration on many paths. It reports:

- quantiles of the ending bankroll and drawdown
- net-outcome and stop-reason counts, each with its denominator
- how often paths hit the run's configured stops under the model

These are model-conditional sensitivity figures, not predictions, not real-world probabilities of loss, and not evidence of profit. See **[docs/UNCERTAINTY.md](docs/UNCERTAINTY.md)**.

**Robustness analysis** (from a completed run, or `/api/simulations/:id/robustness`) splits the run's eligible rounds into 2–10 consecutive periods and replays the same configuration on each period separately, starting again from the configured bankroll. Every result is computed and verified by the server and stored with its dataset fingerprint and versions. The periods are in-sample history: not out-of-sample validation, not predictions, and not evidence of profit. See **[docs/ROBUSTNESS.md](docs/ROBUSTNESS.md)**.

The full contract covers formats, limits, error codes and duplicate rules: **[docs/DATA_IMPORT.md](docs/DATA_IMPORT.md)**. Synthetic example files are in [docs/examples/](docs/examples/).

No round data ships with the application, and none is generated.

## Technology

- **Web:** React 19, Vite 8, TypeScript, Tailwind CSS 4, React Router 7
- **API:** Node.js 22, Express 5, TypeScript
- **Data:** SQLite via `better-sqlite3`, Zod 4 for runtime validation, `csv-parse` for CSV import
- **Quality:** Vitest 5, React Testing Library (jsdom), ESLint 10 + typescript-eslint, Prettier
- **Package manager:** npm workspaces with a committed `package-lock.json`

## Prerequisites

- Node.js **22.12 or newer** (see `.nvmrc`), and npm 10+.
- A platform with prebuilt `better-sqlite3` binaries (Linux, macOS, Windows on x64/arm64). Other platforms need a C/C++ toolchain and Python so the driver can compile.

## Installation

```bash
npm ci        # installs the exact versions from package-lock.json
```

No `.env` file is required. To change a default, copy `.env.example` to `.env` (which git ignores) and edit it. The app needs no credentials and must never be given any.

## Development

```bash
npm run db:migrate   # create/upgrade the SQLite database (the API also does this on start)
npm run dev          # API on http://127.0.0.1:4317 and dashboard on http://127.0.0.1:5173
npm run dev:server   # API only (tsx watch)
npm run dev:web      # dashboard only (Vite; proxies /api to the API)
```

Production-style local run:

```bash
npm run build
npm start            # serves the API from apps/server/dist
npm run preview --workspace @aviator/web   # serves the built dashboard
```

Note: `vite preview` does not proxy `/api`, so the built dashboard shows "API unreachable" when served this way. A combined production server is planned.

## Quality checks

```bash
npm run typecheck      # tsc for shared, server, web and test files
npm run lint           # ESLint
npm run format:check   # Prettier (npm run format to fix)
npm test               # Vitest: shared, server and web projects
npm run build          # compile shared + server, bundle web
npm run check          # all of the above, as CI runs them
```

`npm run typecheck` uses `tsc -b`, which writes the shared and server `dist/` output as a side effect. That output is git-ignored.

## Configuration

| Variable                    | Default               | Notes                                                                  |
| --------------------------- | --------------------- | ---------------------------------------------------------------------- |
| `NODE_ENV`                  | `development`         | `development`, `test` or `production`                                  |
| `API_HOST`                  | `127.0.0.1`           | Non-loopback hosts are refused unless `AVIATOR_ALLOW_REMOTE_BIND=true` |
| `API_PORT`                  | `4317`                | Also read by the Vite dev proxy                                        |
| `AVIATOR_ALLOW_REMOTE_BIND` | `false`               | Leave `false`; the API has no authentication                           |
| `AVIATOR_DB_PATH`           | `data/aviator.sqlite` | Relative to the repository root; `:memory:` is accepted                |
| `AVIATOR_CURRENCY`          | `NGN`                 | Currency for virtual amounts: NGN, USD, GBP or EUR                     |

Configuration is validated at startup. An invalid value stops the process with a message that names the variable but never prints its value.

## Database

- **Location:** `data/aviator.sqlite` by default. The `data/` directory and all `*.sqlite`, `*.db` and WAL/SHM sidecar files are git-ignored.
- **Initialisation:** `npm run db:migrate`, or start the API. Migrations live in `apps/server/src/db/migrations/` and are tracked in a `schema_migrations` table. Each one runs in a transaction. Migrations are append-only: never edit an applied migration; add a new one.
- **Backups:** copy the database file while the API is stopped. Keep backups outside the repository, or in a git-ignored `backups/` folder.
- **Reset:** stop the API and delete `data/aviator.sqlite*`. This permanently deletes all local data.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the schema and the numeric representation policy.

## Architecture

```
packages/shared   Domain types + Zod schemas (money, multipliers, round records, imports, legs, simulation settings, API contracts), analytics and backtest engine
apps/server       Express API, config validation, SQLite connection, migrations, repositories, CSV/JSON import pipeline, backtest persistence
apps/web          React dashboard (pages, components, typed API client)
docs/             Scope, architecture, data import contract, live-observation review checklist, synthetic examples
```

## Data sources and provenance

- No data provider is assumed. In particular, this project does **not** assume that SportyBet or any other operator offers a public API.
- Every round stores its `source`, an optional source-specific round ID, when it was observed or imported, and an optional original event time from a trustworthy source.
- Rounds will come only from documented, permitted imports or from manual entry. The application never generates round history.
- Synthetic test fixtures are flagged `is_synthetic = 1` and are excluded from every dashboard query.

## Limitations

- Crash-game rounds are designed to be independent. Descriptive statistics of past rounds are not evidence of a predictive edge, and a profitable backtest is not evidence of future profit.
- The leg settlement rule (cashout succeeds when crash multiplier ≥ target) is a modelling assumption still to be confirmed against the platform's published rules.
- Backtests replay one historical sequence. They report no risk-of-ruin estimate or confidence intervals, and they cannot model timing, latency or platform limits. See [docs/SIMULATION.md](docs/SIMULATION.md).
- The API has no authentication and is meant for a single local user on loopback only. While bound to loopback, it rejects requests whose `Host` header is not `localhost`, `127.0.0.1` or `[::1]`, which mitigates DNS-rebinding attacks from web pages. This is not complete protection or authentication: any local process can still call it, so do not expose it to a network. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- `npm run dev` may show "Local API unreachable" for a few seconds, because the dashboard can start before the API. Reload once the API has started.
- Import previews are held in API memory: they expire after 15 minutes and are lost when the API restarts.
- If an import fails and recording the failure in history also fails, the attempt appears only in the server log, not in import history.
- Rounds without a source round ID cannot be reliably deduplicated. Identical files are blocked by content hash, but a re-saved copy with different bytes can be imported twice. See [docs/DATA_IMPORT.md](docs/DATA_IMPORT.md).

## License

No license has been chosen yet. Until one is added, all rights are reserved by the repository owner.
