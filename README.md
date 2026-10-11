# Aviator Intelligence

A local-first web dashboard for **researching** the crash-style game Aviator. It records historical rounds with their source, and later phases will add **virtual** simulations of strategy configurations (including two independently configured legs, such as different cashout targets) against that history, with honest reporting of risk and uncertainty.

> **Research and simulation only.**
>
> - No strategy in this project is claimed or guaranteed to be profitable.
> - Past multipliers are not treated as predictors of future multipliers.
> - Live betting, real-money execution, account login and browser automation of betting sites are **not implemented**.
> - All bankroll figures are virtual.

## Current status

Foundation pass 1 and **pass 2 (historical round data manager)** are implemented. See [docs/PROJECT_SCOPE.md](docs/PROJECT_SCOPE.md) for the full implemented / planned / excluded breakdown.

| Area                                                                                                           | Status                                                                                           |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| npm workspace (shared / server / web), strict TypeScript                                                       | Done                                                                                             |
| SQLite database, versioned migrations, initial domain schema                                                   | Done                                                                                             |
| Validated two-leg strategy config and simulation settings (types only)                                         | Done                                                                                             |
| Leg settlement accounting rule (`settleLeg`), unit-tested                                                      | Done                                                                                             |
| Local API: health, meta, overview, rounds (read + manual entry), imports                                       | Done                                                                                             |
| Dashboard shell with honest empty states                                                                       | Done                                                                                             |
| Tests (Vitest + React Testing Library), ESLint, Prettier, CI workflow                                          | Done                                                                                             |
| Round data manager: manual entry, CSV/JSON import with preview, duplicate detection, import history, filtering | Done (pass 2)                                                                                    |
| Simulation engine, backtesting, ledger writes                                                                  | Planned                                                                                          |
| Distribution analysis, charts (Recharts), uncertainty reporting                                                | Planned                                                                                          |
| Playwright browser tests of the dashboard                                                                      | Planned                                                                                          |
| Live observation                                                                                               | Out of scope until reviewed ([docs/LIVE_OBSERVATION_REVIEW.md](docs/LIVE_OBSERVATION_REVIEW.md)) |
| Real-money execution / betting automation                                                                      | Excluded                                                                                         |

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
packages/shared   Domain types + Zod schemas (money, multipliers, round records, imports, legs, simulation settings, API contracts)
apps/server       Express API, config validation, SQLite connection, migrations, repositories, CSV/JSON import pipeline
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
- The API has no authentication and is meant for a single local user on loopback only.
- `npm run dev` may show "Local API unreachable" for a few seconds, because the dashboard can start before the API. Reload once the API has started.
- Import previews are held in API memory: they expire after 15 minutes and are lost when the API restarts.
- If an import fails and recording the failure in history also fails, the attempt appears only in the server log, not in import history.
- Rounds without a source round ID cannot be reliably deduplicated. Identical files are blocked by content hash, but a re-saved copy with different bytes can be imported twice. See [docs/DATA_IMPORT.md](docs/DATA_IMPORT.md).

## License

No license has been chosen yet. Until one is added, all rights are reserved by the repository owner.
