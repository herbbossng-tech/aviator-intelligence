# Architecture

## Layout

```
.
├── packages/shared/            @aviator/shared: framework-free domain code
│   └── src/
│       ├── money.ts            currencies, integer minor-unit schemas, formatting
│       ├── multiplier.ts       x100 multiplier parsing/formatting/schemas
│       ├── legs.ts             two-leg strategy config schema + labelled SAMPLE config
│       ├── simulation.ts       simulation settings, virtual risk stops, dataset selection, settleLeg()
│       └── api.ts              request/response contracts shared by API and dashboard
├── apps/server/                @aviator/server: local Express API
│   ├── src/
│   │   ├── config/env.ts       Zod-validated environment, loopback guard, .env loading
│   │   ├── db/connection.ts    better-sqlite3 connection + pragmas
│   │   ├── db/migrate.ts       transactional, versioned migration runner
│   │   ├── db/migrations/      append-only migrations (001_initial_schema)
│   │   ├── db/repositories/    all SQL lives here (rounds, overview)
│   │   ├── http/               app factory, routes, consistent JSON errors
│   │   ├── scripts/db-migrate.ts
│   │   └── index.ts            entry point
│   └── test/                   config, database and HTTP tests
├── apps/web/                   @aviator/web: React + Vite dashboard
│   ├── src/api/                typed fetch client (validates responses with shared schemas), useApi hook
│   ├── src/components/         shell, panels, stat cards, empty/error states
│   ├── src/pages/              one file per route
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

## API (read-only in this pass)

| Method & path                    | Purpose                            | Notes                                                                          |
| -------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------ |
| `GET /api/health`                | Liveness, DB check, schema version | `200` ok, `503` degraded                                                       |
| `GET /api/meta`                  | App name, version, mode, currency  | Declares `liveObservation: not_connected`, `realMoneyExecution: not_supported` |
| `GET /api/overview`              | Counts from stored data            | `latestVirtualBankroll` is `null` until a run has actually completed           |
| `GET /api/rounds?limit=&offset=` | Paginated rounds, newest first     | `limit` 1–200 (default 50); unknown params → `400`                             |

Errors always use the shape `{ "error": { "code", "message", "details?" } }`:

- `validation_error` (400)
- `bad_request` (400 or other 4xx)
- `not_found` (404)
- `internal_error` (500, generic message; details are logged server-side only)

There are no write endpoints, no filesystem access, no SQL passthrough and no debug routes. The server binds to `127.0.0.1` by default, refuses non-loopback hosts unless `AVIATOR_ALLOW_REMOTE_BIND=true`, disables `X-Powered-By`, sends `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`, and limits JSON bodies to 100 kB.

## Data model

All tables use `INTEGER PRIMARY KEY AUTOINCREMENT` ids, which are stable, never reused, and map directly to PostgreSQL identity columns. Timestamps are ISO-8601 UTC text. JSON columns are checked with `json_valid()` and validated by the shared Zod schemas in the application.

| Table               | Key columns                                                                                                                                                                                               | Constraints                                                                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rounds`            | `multiplier_x100`, `source`, `source_round_id?`, `observed_at`, `event_at?`, `import_id?`, `is_synthetic`, `created_at`                                                                                   | multiplier 100–100,000,000; `UNIQUE(source, source_round_id)` (multiple NULL ids allowed); FK → `data_imports`                                                      |
| `data_imports`      | `source_description`, `source_kind` (`manual_entry`/`file_import`), `status`, `records_total/accepted/rejected`, `error_summary?`, `imported_at`                                                          | counts ≥ 0 and accepted + rejected ≤ total                                                                                                                          |
| `strategies`        | `name` (unique), `description`, `config_json`, `created_at`, `updated_at`                                                                                                                                 | JSON valid                                                                                                                                                          |
| `simulation_runs`   | `strategy_id?`, `strategy_snapshot_json`, `settings_json`, `dataset_json`, `currency`, `starting_bankroll_minor`, `random_seed?`, `status`, `ending_bankroll_minor?`, `rounds_processed?`, timestamps     | summary fields only allowed, and required, when `status = 'completed'`; FK → strategies `ON DELETE SET NULL` (the snapshot preserves the config)                    |
| `ledger_entries`    | `simulation_run_id`, `round_id?`, `sequence_no`, `leg_key` (`A`/`B`), `stake_minor`, `cashout_target_x100`, `gross_return_minor`, `net_minor`, `result` (`win`/`loss`/`skipped`), `bankroll_after_minor?` | `net = gross − stake`; a loss has gross 0; a skip has stake and gross 0; `UNIQUE(run, sequence_no, leg_key)`; FK → runs `ON DELETE CASCADE`, FK → rounds `RESTRICT` |
| `schema_migrations` | `version`, `name`, `applied_at`                                                                                                                                                                           | managed by the runner                                                                                                                                               |

### Deliberate omissions

- **No separate risk-profile table.** Virtual risk stops are part of each run's `settings_json` (validated by `simulationSettingsSchema`), so a run is reproducible from its own row.
- **No users, sessions or credentials tables.** The app is single-user and local, and it must never store betting credentials, cookies, tokens or browser state.
- **No dataset/collection table yet.** Runs select data by round-id range or import id (`datasetSelectionSchema`). A named-dataset table can be added when import exists.
- **No stored derived statistics.** Analytics will be computed from rounds and ledgers rather than cached.

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
