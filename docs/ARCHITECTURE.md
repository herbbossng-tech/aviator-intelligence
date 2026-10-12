# Architecture

## Layout

```
.
├── packages/shared/            @aviator/shared: framework-free domain code
│   └── src/
│       ├── money.ts            currencies, integer minor-unit schemas, formatting
│       ├── multiplier.ts       x100 multiplier parsing/formatting/schemas
│       ├── legs.ts             two-leg strategy config schema + labelled SAMPLE config
│       ├── rounds.ts           canonical round record validation (the single path for CSV, JSON and manual entry)
│       ├── imports.ts          import limits, preview/confirm/history contracts
│       ├── analytics.ts        descriptive statistics (quantiles, P(M ≥ t), Wilson CI, histogram) + API contract
│       ├── simulation.ts       simulation settings, virtual risk stops, dataset selection, settleLeg()
│       └── api.ts              request/response contracts shared by API and dashboard
├── apps/server/                @aviator/server: local Express API
│   ├── src/
│   │   ├── config/env.ts       Zod-validated environment, loopback guard, .env loading
│   │   ├── db/connection.ts    better-sqlite3 connection + pragmas
│   │   ├── db/migrate.ts       transactional, versioned migration runner
│   │   ├── db/migrations/      append-only migrations (001_initial_schema, 002_round_imports)
│   │   ├── db/repositories/    all SQL lives here (rounds, imports, analytics, overview)
│   │   ├── imports/            CSV/JSON parsing, record classification, preview store, transactional confirm
│   │   ├── http/               app factory, routes, consistent JSON errors
│   │   ├── scripts/db-migrate.ts
│   │   └── index.ts            entry point
│   └── test/                   config, database and HTTP tests
├── apps/web/                   @aviator/web: React + Vite dashboard
│   ├── src/api/                typed fetch client (validates responses with shared schemas), useApi hook
│   ├── src/components/         shell, panels, stat cards, empty/error states
│   ├── src/pages/              one file per route; pages/rounds/ holds the round data manager
│   └── test/                   React Testing Library tests (fetch is stubbed)
└── docs/
```

### How the packages connect

- `@aviator/shared` publishes a `source` export condition that points at its TypeScript source, plus a default condition that points at the compiled `dist/`.
- Vite, Vitest and `tsx` (server dev mode) resolve the `source` condition, so no pre-build is needed during development.
- The compiled server (`npm start`) resolves the default condition, i.e. `packages/shared/dist`. `npm run build` compiles shared first via TypeScript project references (`tsc -b`).

### Request flow

```
browser ──/api/*──▶ Vite dev proxy (127.0.0.1:5173) ──▶ Express (127.0.0.1:4317) ──▶ repositories ──▶ SQLite
```

The dashboard validates every response against the shared Zod schemas. A malformed response becomes an error state; it is never rendered as data.

## API

| Method & path                              | Purpose                                       | Notes                                                                                                                                                                                                      |
| ------------------------------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                          | Liveness, DB check, schema version            | `200` ok, `503` degraded                                                                                                                                                                                   |
| `GET /api/meta`                            | App name, version, mode, currency             | Declares `liveObservation: not_connected`, `realMoneyExecution: not_supported`                                                                                                                             |
| `GET /api/overview`                        | Counts from stored data                       | `latestVirtualBankroll` is `null` until a run has actually completed                                                                                                                                       |
| `GET /api/rounds`                          | Paginated, filterable rounds                  | `limit` 1–200, `offset`, `source`, `q`, `importId`, `minMultiplier`, `maxMultiplier`, `sort`; unknown params → `400`                                                                                       |
| `GET /api/rounds/sources`                  | Source labels with counts                     | Synthetic rows excluded                                                                                                                                                                                    |
| `POST /api/rounds`                         | Manual entry of one round                     | `201`; `400` field errors; `409 duplicate_source_id` / `possible_duplicate`                                                                                                                                |
| `POST /api/imports/preview`                | Validate and preview a CSV/JSON file          | Writes nothing; body limit 5 MB, content limit 2 MiB                                                                                                                                                       |
| `DELETE /api/imports/previews/:id`         | Discard a preview                             | `204`                                                                                                                                                                                                      |
| `POST /api/imports`                        | Confirm a preview by `previewId`              | One transaction; `201`, `404 preview_not_found`, `409 duplicate_import`, `500 database_write_failed`                                                                                                       |
| `GET /api/imports`, `GET /api/imports/:id` | Import history                                | Newest first                                                                                                                                                                                               |
| `GET /api/analytics`                       | Descriptive statistics of the selected rounds | Read-only; filters `source`, `importId`, `minMultiplier`, `maxMultiplier`, `eventFrom` (incl.), `eventTo` (excl.), `thresholds`; `422 dataset_too_large` above 5M rounds. See [ANALYTICS.md](ANALYTICS.md) |

The full import contract, including limits and error codes, is in [DATA_IMPORT.md](DATA_IMPORT.md).

Errors always use the shape `{ "error": { "code", "message", "details?" } }`:

- `validation_error`, `invalid_request_json` (400)
- `not_found`, `preview_not_found` (404)
- conflicts (409)
- `payload_too_large`, `file_too_large` (413)
- file-content errors (422)
- `database_write_failed`, `internal_error` (500, generic message; details are logged server-side only)

The only write endpoints are manual round entry and import preview/confirm. They write only through fixed, parameterised statements: there are no generic table writes, no filesystem access, no URL fetching, no SQL passthrough and no debug routes.

Binding, the Host check and cross-site behaviour are described under **Local-only security model** below. The server also:

- disables `X-Powered-By`
- sends `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`
- limits JSON bodies to 100 kB (5 MB for import preview only)

### Local-only security model

- **Binding:** the API binds to `127.0.0.1` by default. A non-loopback `API_HOST` is refused at startup unless `AVIATOR_ALLOW_REMOTE_BIND=true`.
- **Host check (DNS-rebinding mitigation):** while `API_HOST` is a loopback name, every request must carry a well-formed `Host` header naming `localhost`, `127.0.0.1` or `[::1]` (any port). Otherwise it gets `403 forbidden_host`. A web page on another domain that re-points its name at 127.0.0.1 still sends its own `Host` header, so it is refused. Malformed values (`[::1]evil.example`, `localhost:1:2`) are refused, and requests with no `Host` header are rejected by Node itself (400). The Vite dev proxy forwards `Host: 127.0.0.1:5173`, which is allowed.
- **Cross-site requests:** JSON bodies are parsed only for `Content-Type: application/json`, and the API sends no CORS headers, so other sites can neither read responses nor send JSON writes.
- **What this does not cover:** the Host check is one mitigation, not complete protection, and it is not authentication.
  - Any process on the machine can call the API.
  - Tools that send a forged `Host` header are not browsers and are not stopped by it.
  - Binding to a non-loopback address with `AVIATOR_ALLOW_REMOTE_BIND=true` turns the check off entirely, and the API has no authentication.

  Do not expose the API to a network; that would first need authentication.

## Data model

All tables use `INTEGER PRIMARY KEY AUTOINCREMENT` ids, which are stable, never reused, and map directly to PostgreSQL identity columns. Timestamps are ISO-8601 UTC text. JSON columns are checked with `json_valid()` and validated by the shared Zod schemas in the application.

| Table               | Key columns                                                                                                                                                                                                                                | Constraints                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rounds`            | `multiplier_x100`, `source`, `source_round_id?`, `observed_at`, `event_at?`, `import_id?`, `is_synthetic`, `created_at`                                                                                                                    | multiplier 100–100,000,000; `UNIQUE(source, source_round_id)` (multiple NULL ids allowed); FK → `data_imports`                                                                 |
| `data_imports`      | `source_description` (the declared source label), `notes?`, `source_kind`, `format` (`csv`/`json`), `status`, `records_total/accepted/rejected/duplicate`, `content_sha256`, `error_summary?`, `started_at`, `completed_at`, `imported_at` | counts ≥ 0; triggers enforce accepted + rejected + duplicate ≤ total (= total once completed); partial UNIQUE index on `content_sha256` for successful imports (migration 002) |
| `strategies`        | `name` (unique), `description`, `config_json`, `created_at`, `updated_at`                                                                                                                                                                  | JSON valid                                                                                                                                                                     |
| `simulation_runs`   | `strategy_id?`, `strategy_snapshot_json`, `settings_json`, `dataset_json`, `currency`, `starting_bankroll_minor`, `random_seed?`, `status`, `ending_bankroll_minor?`, `rounds_processed?`, timestamps                                      | summary fields only allowed, and required, when `status = 'completed'`; FK → strategies `ON DELETE SET NULL` (the snapshot preserves the config)                               |
| `ledger_entries`    | `simulation_run_id`, `round_id?`, `sequence_no`, `leg_key` (`A`/`B`), `stake_minor`, `cashout_target_x100`, `gross_return_minor`, `net_minor`, `result` (`win`/`loss`/`skipped`), `bankroll_after_minor?`                                  | `net = gross − stake`; a loss has gross 0; a skip has stake and gross 0; `UNIQUE(run, sequence_no, leg_key)`; FK → runs `ON DELETE CASCADE`, FK → rounds `RESTRICT`            |
| `schema_migrations` | `version`, `name`, `applied_at`                                                                                                                                                                                                            | managed by the runner                                                                                                                                                          |

Migration 002 (`round_imports`) is additive: it adds the `data_imports` columns, the counter triggers, the content-hash index and an index on `rounds (source, event_at)`. Migration 001 was not edited. SQLite cannot add table-level CHECK constraints to an existing table without rebuilding it, and rebuilding requires disabling foreign keys, so the counter rules are triggers.

### Deliberate omissions

- **No separate risk-profile table.** Virtual risk stops are part of each run's `settings_json` (validated by `simulationSettingsSchema`), so a run is reproducible from its own row.
- **No users, sessions or credentials tables.** The app is single-user and local, and it must never store betting credentials, cookies, tokens or browser state.
- **No dataset/collection table yet.** Runs select data by round-id range or import id (`datasetSelectionSchema`). An import already acts as a named dataset.
- **Manual entries create no `data_imports` row.** Their provenance is the round's `source` label, and `import_id` is NULL.
- **No stored derived statistics.** Analytics are computed on request from the stored rounds: SQLite returns a `GROUP BY multiplier_x100` frequency table, and `computeAnalytics` in `@aviator/shared` derives every statistic. Nothing is cached or written. Round filters for the browser and analytics share one SQL builder (`roundFilterSql`).

## Numeric representation and rounding policy

- **Money:** JavaScript integers in the currency's minor unit (kobo, cents), stored as SQLite `INTEGER`.
  - A single amount is capped at 10¹² minor units, so products stay below `Number.MAX_SAFE_INTEGER`.
  - Formatting splits integer and fractional parts without floating-point division.
- **Multipliers:** integers scaled by 100 (`2.35x` → `235`), matching Aviator's two displayed decimals. Text with more than two decimals is **rejected**, not rounded, so imported data is never silently altered. Round multipliers must be ≥ 1.00x; cashout targets must be ≥ 1.01x.
- **Settlement (`settleLeg`):**
  - A leg wins when `round_multiplier_x100 ≥ cashout_target_x100`. This is a modelling assumption still to be confirmed against the platform's published rules.
  - The gross return is `floor(stake_minor × target_x100 / 100)`, rounded down to the nearest minor unit (conservative).
  - A loss returns 0, so the net loss equals the stake.
- **Ratios** (future analytics, such as drawdown) are configured in integer basis points. Floating point may be used for _statistics_ such as means and confidence intervals, but never for ledger balances.

## Migrations

`apps/server/src/db/migrations/index.ts` holds an ordered, contiguous list.

- `migrate()` applies the pending migrations one by one. Each migration's SQL and its `schema_migrations` row are applied in one transaction.
- It refuses a database whose schema version is newer than the application supports.
- To change the schema, add `00N_description.ts` and append it to the list. Never edit a migration that has been applied.

## PostgreSQL path

All SQL is confined to `apps/server/src/db/` (connection, migrations, repositories). Moving to PostgreSQL would mean:

- a new driver in `connection.ts`
- translating the migration SQL (`AUTOINCREMENT` → identity, `strftime` defaults → `now()`, `json_valid` checks → `jsonb`)
- making the repository functions async

The routes and the dashboard would not need to change.
