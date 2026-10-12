# Historical round data: contract, import and manual entry

This document is the reference for how rounds enter Aviator Intelligence.

- **Validation:** one path, shared by CSV import, JSON import, manual entry and the manual-entry form. It lives in `packages/shared/src/rounds.ts`.
- **Server pipeline:** `apps/server/src/imports/`.

## 1. Canonical round record

The field names are identical in CSV headers, JSON keys and the manual-entry API body.

| Field           | Required | Accepted input                                                                                                                                               | Stored as                                                                                           |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `multiplier`    | yes      | Decimal text (`"2"`, `"2.5"`, `"2.35"`) or a JSON number (`2.35`). At most **two decimal places**, minimum **1.00**, maximum **1000000.00**.                 | `rounds.multiplier_x100` INTEGER (2.35 → 235)                                                       |
| `sourceRoundId` | no       | The identifier the data source shows for the round, at most 128 characters with no control characters. A JSON integer is accepted as its decimal text.       | `rounds.source_round_id` (NULL if absent)                                                           |
| `eventAt`       | no       | ISO-8601 date-time **with an explicit offset**: `2026-01-31T14:05:09Z`, `2026-01-31T15:05:09.123+01:00`. Seconds and up to 3 fractional digits are optional. | `rounds.event_at`, normalised to UTC with milliseconds (`2026-01-31T14:05:09.000Z`); NULL if absent |

Set by the application:

| Value        | Meaning                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `source`     | The provenance label. It is declared once per import (or per manual entry) and applied to every round. Required: 1–100 characters, no control characters. It is stored as `rounds.source`. |
| `id`         | Stable internal round ID (`INTEGER PRIMARY KEY AUTOINCREMENT`, never reused).                                                                                                              |
| `observedAt` | When the record entered this application: the import time, or the time a manual entry was saved. It is kept separate from `eventAt`.                                                       |
| `importId`   | The import that stored the round, or NULL for manual entries.                                                                                                                              |

### Multiplier rules

The following inputs are rejected and **never rounded or corrected**:

- missing or blank values
- zero, negative values and values below 1.00
- more than two decimals (`2.345`, and JSON numbers such as `0.30000000000000004`)
- exponent notation (`1e3`)
- thousands separators or decimal commas (`2,5`)
- a trailing `x` (`2.35x`)
- `NaN` or infinity
- non-numeric types
- values above 1,000,000.00x

The 1,000,000x cap is a guard against corrupted input, not a claim about the game.

### Timestamp rules

- Event times are optional, because many sources do not supply a trustworthy one. A missing time stays NULL and is never filled in.
- A time without a time zone (`2026-01-31T14:05:09`) is **rejected**, because guessing UTC or local time would silently change the data.
- Also rejected:
  - impossible dates (`2025-02-29`)
  - out-of-range fields
  - offsets beyond ±14:00
  - more than 3 fractional digits
  - times before 2000-01-01
  - times more than 5 minutes in the future (a tolerance for clock skew)

### Source / provenance rules

- Describe where the data really came from (for example `personal-observation-log-2026-01`). Do not label data as coming from SportyBet or any other operator unless it did.
- Source round IDs are only stored when the source provides them. The application never invents them.
- Synthetic test fixtures are flagged in the database (`is_synthetic = 1`) and excluded from every dashboard query. Imports and manual entries are always stored as non-synthetic, so try the example files only in a throwaway database (see `docs/examples/README.md`).

## 2. File formats

### CSV

```csv
multiplier,sourceRoundId,eventAt
2.35,R-1001,2026-01-31T14:05:09Z
1.00,R-1002,
17.50,,2026-01-31T14:06:01+01:00
```

- UTF-8. A byte-order mark is ignored.
- Content that is not valid UTF-8 (replacement characters) or that contains NUL characters is rejected as `invalid_encoding`.
- Comma-delimited, first row is the header. RFC 4180 quoting is supported: quoted fields may contain commas, `""` and line breaks.
- Blank lines are skipped.
- Header names are case-sensitive and must be exactly `multiplier`, `sourceRoundId` and `eventAt`, in any order. `multiplier` is required. Unknown or repeated headers reject the whole file.
- A row with a different number of fields from the header is rejected (`invalid_record`). The other rows are still processed.
- Values are trimmed. An empty optional field means "absent".
- Line numbers in messages are the line on which the record **ends** (the header is line 1).

### JSON

```json
[
  { "multiplier": "2.35", "sourceRoundId": "R-1001", "eventAt": "2026-01-31T14:05:09Z" },
  { "multiplier": 1.0, "sourceRoundId": 1002 }
]
```

or, equivalently, the wrapper `{ "rounds": [ ... ] }` with no other top-level keys.

- Content is only passed to `JSON.parse`; nothing is evaluated.
- Any other root shape is rejected (`invalid_json`).
- Each element must be an object, and is validated independently.
- Unknown keys reject that record (`unknown_field`).
- `null` or `""` for an optional field means "absent".

Synthetic example files are in [`docs/examples/`](examples/).

## 3. Limits

These are fixed in `IMPORT_LIMITS` (`packages/shared/src/imports.ts`), so the API and the dashboard enforce the same values.

| Limit                        | Value                                             | When exceeded                                                     |
| ---------------------------- | ------------------------------------------------- | ----------------------------------------------------------------- |
| File size (UTF-8 bytes)      | 2 MiB (2,097,152 bytes)                           | `413 file_too_large`. The dashboard also checks before uploading. |
| Records per file             | 10,000                                            | `422 too_many_records`                                            |
| Preview rows returned        | first 100                                         | `rowsTruncated: true`                                             |
| Validation messages returned | first 200                                         | `issuesTruncated: true`                                           |
| Preview lifetime             | 15 minutes, single use                            | `404 preview_not_found`                                           |
| Pending previews held        | 5 (oldest evicted)                                | `404 preview_not_found` for an evicted preview                    |
| Import notes                 | 500 characters                                    | `400 validation_error`                                            |
| Request body                 | 5 MB for `/api/imports/preview`, 100 kB elsewhere | `413 payload_too_large`                                           |

## 4. Import workflow

1. **Preview** (`POST /api/imports/preview` with `{format, source, notes?, content}`). The server validates and parses the file, classifies every record, and compares it with stored rounds. It **writes nothing to the database**. It keeps the parsed records in memory under a random `previewId` and returns:
   - counts (total, new, invalid, already stored, repeats in file, possible duplicates)
   - the first 100 rows with status and messages
   - the first 200 validation messages
   - the SHA-256 of the content
   - `alreadyImported`, if this exact content was imported before
2. **Confirm** (`POST /api/imports` with `{previewId}` only). The server uses only the records it stored at preview time; record data and counts sent by a client are never trusted. Previews are single-use, so a second confirm returns `404 preview_not_found`.
3. **Cancel** (`DELETE /api/imports/previews/:previewId`) discards a preview.

Previews live in memory and do not survive an API restart.

### Record classification

| Status               | Meaning                                                            | Stored?                                   |
| -------------------- | ------------------------------------------------------------------ | ----------------------------------------- |
| `new`                | Valid, and no stored round has the same source and `sourceRoundId` | yes                                       |
| `invalid`            | Failed validation, or a conflicting repeat within the file         | no                                        |
| `duplicate_existing` | A round with the same `source` + `sourceRoundId` is already stored | no; the stored round is **never changed** |
| `duplicate_in_file`  | An identical repeat of an earlier record in the same file          | no                                        |

## 5. Duplicate detection

- **Identity:** a round with a `sourceRoundId` is identified by **(source, sourceRoundId)**. A database `UNIQUE (source, source_round_id)` constraint is the final safeguard. The same ID under a different source label is a different round.
- **Repeats within one file:**
  - If every repeat of a `sourceRoundId` has the same multiplier and `eventAt`, the first occurrence is processed normally and the later ones are skipped (`duplicate_in_file`).
  - If the repeats **disagree**, all occurrences are rejected (`conflicting_duplicate_in_file`), because there is no safe way to choose between them.
- **Rounds without a `sourceRoundId` are never deduplicated.** Repeated multipliers are legitimate.
  - When such a record's source, `eventAt` and multiplier all match another record in the file or a stored round, it gets a `possible_duplicate` **warning**, and it is still stored on import.
  - Manual entry asks for explicit confirmation in that case: `409 possible_duplicate`, then resend with `allowPossibleDuplicate: true`.
  - Recommendation: include source round IDs whenever the source provides them.
- **Same file twice:**
  - Every import stores the SHA-256 of its content.
  - Confirming content that already has a successful import returns `409 duplicate_import` and stores nothing. A partial unique index enforces this in the database.
  - A re-export with different bytes but the same IDs is accepted, but its records are classified `duplicate_existing`, so nothing is double-counted.
  - Files without source round IDs whose bytes differ (for example, with an extra blank line) **can** be imported twice. This is a known limitation of data without identifiers.
- **Changes since the preview:** duplicates are re-checked inside the confirm transaction, in case the database changed after the preview.

## 6. Transactions and import history

The confirm step runs as **one SQLite transaction**:

1. Create the import row (`pending`).
2. Insert each new round with `import_id` set and `observed_at` set to the import time.
3. Set the final counters and status.

It commits only if every step succeeds. If anything fails, the whole transaction is rolled back. Then a separate `failed` import row is written with:

- `records_accepted = 0`
- the record total
- a generic `error_summary`

The real error is logged on the server only. The API returns `500 database_write_failed`.

If writing that `failed` row also fails (for example, the database is unavailable), the API still returns `500 database_write_failed` and nothing is stored. The attempt is then **missing from import history**; only the server log records it (both errors are logged). This case is covered by a test.

Import history fields (`GET /api/imports`, `GET /api/imports/:id`):

| Field                                                                        | Meaning                                                                                                                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `recordsTotal`                                                               | Records found in the file                                                                                                                   |
| `recordsAccepted`                                                            | Rounds actually inserted by this import                                                                                                     |
| `recordsRejected`                                                            | Invalid records                                                                                                                             |
| `recordsDuplicate`                                                           | Already stored + repeats in file (skipped)                                                                                                  |
| `status`                                                                     | `completed` (everything stored), `completed_with_rejections` (some records invalid or duplicate), or `failed` (rolled back; nothing stored) |
| `contentSha256`, `format`, `notes`, `startedAt`, `completedAt`, `importedAt` | Metadata                                                                                                                                    |

Database triggers enforce `accepted + rejected + duplicate ≤ total`, and require equality for completed imports. Previews that are never confirmed are not recorded. Manual entries do not create import rows.

## 7. Error codes

**Record-level** (in `issues` and `warnings`):

- `missing_required_field`
- `invalid_multiplier`
- `invalid_timestamp`
- `invalid_source_round_id`
- `unknown_field`
- `invalid_record`
- `duplicate_source_id`
- `duplicate_in_file`
- `conflicting_duplicate_in_file`
- `possible_duplicate` (warning)

**Request-level** (`{ "error": { "code", "message", "details?" } }`):

| HTTP | Code                                                                                                                    | Cause                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 400  | `validation_error`                                                                                                      | Bad body or query shape, or invalid manual-entry fields. `details` is `[{path, message, code?}]`. |
| 400  | `invalid_request_json`                                                                                                  | The request body is not JSON                                                                      |
| 404  | `preview_not_found`                                                                                                     | Preview expired, evicted or already used                                                          |
| 409  | `duplicate_source_id`                                                                                                   | Manual entry: same source + `sourceRoundId` already stored (`details.roundId`)                    |
| 409  | `possible_duplicate`                                                                                                    | Manual entry: same source, `eventAt` and multiplier, and no `sourceRoundId`                       |
| 409  | `duplicate_import`                                                                                                      | This exact content was already imported successfully                                              |
| 413  | `file_too_large` / `payload_too_large`                                                                                  | Over the byte limits                                                                              |
| 422  | `empty_file`, `invalid_encoding`, `invalid_csv`, `invalid_header`, `invalid_json`, `too_many_records`, `invalid_source` | File-level problems; `details.line` where known                                                   |
| 422  | `nothing_to_import`                                                                                                     | Confirm on a preview with no valid records                                                        |
| 500  | `database_write_failed`                                                                                                 | The write was rolled back; nothing was stored                                                     |
| 500  | `internal_error`                                                                                                        | Unexpected error; details are logged on the server only                                           |

## 8. Manual entry

In the dashboard: **Round data → Add a round**. You can also call `POST /api/rounds`:

```json
{
  "source": "manual entry",
  "multiplier": "2.35",
  "sourceRoundId": "R-1001",
  "eventAt": "2026-01-31T14:05:09Z"
}
```

- **Validation:** the same rules as import. The form checks the input first for usability, and the server re-validates everything. Unknown body fields are rejected.
- **On success:** returns `201 { round }`.
- **On a duplicate:**
  - an existing (source, `sourceRoundId`) returns `409 duplicate_source_id`, and the stored round is unchanged
  - a possible duplicate without an ID returns `409 possible_duplicate`
- **While saving:** the form keeps its input until the server confirms success, and disables the button while a request is in flight.

## 9. Browsing

`GET /api/rounds` supports these query parameters; unknown parameters are rejected:

- `limit` (1–200) and `offset`
- `source` (exact match)
- `q` (case-insensitive substring of `sourceRoundId`; LIKE wildcards are escaped)
- `importId`
- `minMultiplier` and `maxMultiplier` (decimal text, same rules as multiplier input)
- `sort`: `recorded_desc` (default), `event_desc` or `event_asc`. Rounds without an event time sort last.

`GET /api/rounds/sources` lists the source labels with their counts.
