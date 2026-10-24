# Crossroads Formula Engine

A versioned formula engine for insurance and finance rules. Formulas are stored as data, resolved into a dependency order, evaluated with `formula-interpreter`, and explained result by result. Every business change is an insert. Nothing in the application updates or deletes a business row.

## Stack

- Node.js 20 or newer
- Express 5
- MySQL 8
- TypeScript with ESM modules
- `formula-interpreter` for evaluation
- `mysql2/promise` for database access
- Zod for request validation
- `node:test`, `tsx`, and `supertest` for tests

## Project Layout

```text
src/
  app.ts                  Express app and middleware
  server.ts               Startup and shutdown
  config/                 Environment parsing
  routes/                 Route definitions
  validation/             Zod request schemas
  controllers/            HTTP request and response handling
  services/               Formula, preview, bulk, and report logic
  data/                   MySQL pool, repositories, table registry, saveRecord
  lib/                    Graph, evaluator, worker pool, errors, concurrency
sql/
  schema.sql              Tables, constraints, indexes, and both current views
  queries.sql             Reports 1-7
tests/                    Unit, integration, endpoint, and performance tests
```

## Setup

### 1. Prerequisites

Install Node.js 20 or newer, npm, and MySQL 8 or newer. The SQL uses window functions, recursive CTEs, and `JSON_TABLE`, so MySQL 8 is required.

Create a development database and a separate test database:

```sql
CREATE DATABASE crossroads;
CREATE DATABASE crossroads_test;
```

The test configuration refuses a database name that does not end with `_test`.

### 2. Install dependencies

```bash
npm install
```

### 3. Configure the environment

Copy `.env.example` to `.env` and fill in the local database credentials:

```bash
cp .env.example .env
```

For tests, copy `.env.test.example` to `.env.test` and use the test database. Do not point tests at the development database.

The application defaults to port `4000`; the test configuration uses port `4001`. The port is not used by the in-process `supertest` tests.

### 4. Create the schema

Apply the schema to both databases:

```bash
mysql -u root -p crossroads < sql/schema.sql
mysql -u root -p crossroads_test < sql/schema.sql
```

With Docker:

```bash
docker exec -i crossroads-mysql mysql -uroot -p crossroads < sql/schema.sql
docker exec -i crossroads-mysql mysql -uroot -p crossroads_test < sql/schema.sql
```

The schema is safe to apply more than once because it uses `CREATE TABLE IF NOT EXISTS` and `CREATE OR REPLACE VIEW`.

The report queries are in `sql/queries.sql`. They are read-only examples and are not needed by the API at startup.

### 5. Run

```bash
npm run dev
```

The server listens on `http://localhost:4000`.

```bash
curl http://localhost:4000/health
```

Expected response:

```json
{"status":"ok","database":"connected"}
```

### 6. Verify

```bash
npm run typecheck
npm test
```

Tests use unique names and leave rows in `crossroads_test`. The test database is disposable by design.

## Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test`, or `production` |
| `PORT` | `4000` | HTTP port |
| `DB_HOST` | `127.0.0.1` | MySQL host |
| `DB_PORT` | `3306` | MySQL port |
| `DB_USER` | `root` | MySQL user |
| `DB_PASSWORD` | empty | MySQL password |
| `DB_NAME` | `crossroads` (`crossroads_test` in test) | Database name |
| `DB_CONNECTION_LIMIT` | `10` | MySQL pool size |
| `FORMULA_TIMEOUT_MS` | `500` | Per-formula timeout |
| `PREVIEW_CONCURRENCY` | `4` | Formula concurrency inside one preview level |
| `BULK_RECORD_CONCURRENCY` | `4` | Record concurrency in bulk preview |
| `FORMULA_CONCURRENCY` | `8` | Shared formula-evaluation limit across bulk records |

The test configuration lowers the concurrency values so tests remain deterministic.

## Data Model

### `formulas`

One row is one immutable version of a logical formula.

- `id`: auto-increment row identity. The highest id for a UUID is the current row.
- `uuid`: stable logical identity across versions.
- `version`: 1-based version number for this UUID.
- `name`: result name and formula identifier, such as `tax`.
- `formula_text`: the complete JavaScript formula ending in `return`.
- `status`: `ACTIVE` or `INACTIVE`.
- `created_by`: creator label, default `system`.
- `first_created_at`: creation time of version 1, preserved on later versions.
- `inserted_at`: time this row was inserted.
- `inputs`: JSON array of `EXTERNAL_VAR.<name>` references extracted from `formula_text`.

### `formula_runs`

One row is one formula evaluation. Rows are grouped by `run_uuid` and, for bulk requests, by `record_index`.

- `run_uuid`: one UUID per single preview or per bulk record.
- `formula_uuid`, `formula_name`, `formula_version`: exact formula version used.
- `record_index`: zero-based record position in a bulk request; `0` for single preview.
- `input_json`: the exact data object passed to the evaluator.
- `result`: rounded result or `NULL`.
- `calculation_text`: raw explanation text from the evaluator.
- `error`: failure text or skip reason.
- `status`: `SUCCESS`, `FAILED`, or `SKIPPED`.
- `inserted_at`: row insertion time.

### Index Rationale

`formulas`:

- Primary key on `id` gives each version a stable row identity and supports latest-row ordering.
- Unique `(uuid, version)` makes version conflicts impossible and supports version lookups.
- `(uuid, id)` supports the current-row and history access paths.
- `(status, name)` supports the active-formula list and name checks.
- `name` supports name-oriented lookups and report joins.

`formula_runs`:

- Primary key on `id` gives each evaluation a stable identity.
- `run_uuid` supports grouping all rows for one preview.
- `(formula_uuid, inserted_at)` supports the last-seven-days and per-formula failure reports.
- `(inserted_at, status)` supports recent failure scans and status-filtered reports.

### Current-Formula Views

Both views are defined in `sql/schema.sql`:

- `current_formulas_aggregate` joins each formula row to `MAX(id)` per UUID.
- `current_formulas_window` uses `ROW_NUMBER() OVER (PARTITION BY uuid ORDER BY id DESC)` and keeps rank `1`.

The application uses `current_formulas_window`.

On 3,019 formula rows covering 1,509 UUIDs in MySQL 8.4.11, a single-UUID lookup through the window view read 2 rows in about 0.07 ms, while the aggregate view materialized all 1,509 groups and took about 2.4 ms. The ordered active list took about 18.1 ms with the window view and 23.4 ms with the aggregate view. The aggregate view was faster only for an unordered full scan, about 4.8 ms versus 16.0 ms. Point lookups and the ordered active list are the application's main paths, so the window view is the better fit and has simpler SQL. Both views returned the same 1,509 current rows.

### Reports

`sql/queries.sql` defines the seven required reports:

1. Full version history for one UUID, oldest first.
2. Active formulas in dependency execution order, using a recursive CTE over the stored `inputs` JSON with `JSON_TABLE`.
3. Number of versions per formula UUID.
4. Last seven days per formula: total runs, failed runs, skipped runs, and failure percentage. A run is every run row; a failure is `FAILED` only, and `SKIPPED` stays in the total and is shown separately.
5. Top five most-failing formulas in the last seven days by `FAILED` count, with ties broken by the most recent failure, including the latest error text. No minimum-run threshold is applied.
6. Formulas whose current row is `INACTIVE` and whose first `INACTIVE` row has no later `ACTIVE` row.
7. Time between consecutive versions using `LAG(inserted_at)`, plus the average non-null gap per formula. The first version has no gap and is excluded from the average.

## Insert-Only Write Path

Every business write goes through `saveRecord` in `src/data/save-record.ts`. Routes and services never insert rows directly.

For a new logical record, `saveRecord` generates a UUID, sets `first_created_at`, sets version 1, and inserts. For an existing record, it loads the current row, preserves immutable creation fields, merges only sent fields, increments the version, and inserts a new row. An array is inserted with one multi-row statement inside a transaction. Any failure rolls back the entire save.

No application code runs `UPDATE` or `DELETE` against `formulas` or `formula_runs`.

### Concurrency Guarantee

A change request must include the version the client last saw. The service compares it with the current row for a fast rejection. `saveRecord` also checks `expectedVersion` inside its own transaction, so a request that read an old base cannot slip through after another request commits. The unique `(uuid, version)` key is the final race guard.

If two requests use the same base version, exactly one inserts the next version. The other receives `409 VERSION_CONFLICT` with the current row in `error.details.current`.

The HTTP-layer test `POST /formulas serializes simultaneous changes on the same base version` sends two requests with `Promise.all` and asserts exactly one `200` and one `409`.

## Formula Engine

### Input Extraction

`src/lib/formula-inputs.ts` strips strings and comments, then extracts dot-notation `EXTERNAL_VAR.<name>` references. Bracket notation and the internal `EXTERNAL_VAR.CODE` path are ignored. Extracted names are stored in `formulas.inputs` so previews and reports do not need to re-parse the formula text.

### Dependency Graph and Execution Order

`src/lib/dependency-graph.ts` classifies every input as a formula dependency or a record field. Active formula names win over same-named record fields. It builds forward and reverse adjacency, computes topological levels, detects cycles with their exact path, collects missing record inputs, and traverses impact with depth and path.

Formulas in a level do not depend on each other, so they run in parallel. A formula runs only after every level it depends on has completed. The worked example is always `commission -> tax -> total`, even when the formulas are created in reverse order.

### Selection

- No `formulaUuids`: all active formulas in the snapshot.
- `formulaUuids: []`: an empty selection.
- A requested subset is closed over formula-name dependencies. Dependencies added by the closure have `autoAdded: true`.
- Unknown requested UUIDs return `404 NOT_FOUND` with the deduplicated UUIDs in `error.details.uuids`.

### Timeout, Failure, and Skip Behaviour

Each formula has a timeout, default 500 ms. A timeout kills and replaces the worker and marks that formula `FAILED`. A returned failure or thrown evaluator error is also `FAILED`.

Every transitive dependent of a failed formula is marked `SKIPPED` with `reason: "dependency <root-failure> failed"`. Independent branches continue. A preview still returns HTTP `200` when formulas fail; only request errors return `4xx`.

Every evaluated formula writes one run-log row, including `FAILED` and `SKIPPED` rows. Single preview uses one run UUID and one multi-row insert. Bulk preview groups rows by each record's run UUID and `record_index`, then inserts in 500-row chunks through `saveRecord`.

### Rounding

Successful numeric results are rounded at the output boundary with `Number(value.toFixed(2))`. Dependents receive the raw unrounded value so rounding error does not compound. The test `executePreview rounds 0.1 plus 0.2 to 0.3 at the output boundary` proves `0.1 + 0.2` is exposed as `0.3`, not `0.30000000000000004`.

### As-Of Previews

An `asOf` value must be an ISO 8601 timestamp with a timezone. The snapshot query keeps rows where `inserted_at <= asOf`, ranks them by id descending per UUID, keeps the highest row, and then keeps only `ACTIVE` rows.

A timestamp before the first row returns an empty snapshot. A future timestamp resolves to the current state. Without `asOf`, the current view is used.

### Bulk Preview

`POST /formulas/preview/bulk` accepts 1 to 500 record objects, with the same optional `formulaUuids` and `asOf` fields as single preview.

The snapshot, selection, and dependency plan are built once per request. Every record's missing inputs are checked before any evaluation. Records run through a bounded record pool, all formula calls share one formula limiter, and each record keeps its own level concurrency.

Each record gets its own run UUID. The response contains per-record results and a summary:

- `totalRecords`
- `totalFormulas`: total formula outcomes across records, including failed and skipped outcomes
- `totalMs`: execution, logging, and response-building time
- `avgMsPerRecord`: `totalMs / totalRecords`, rounded to two decimals
- `failedRecords`: records whose status is `FAILED`
- `failedFormulas`: total `FAILED` outcomes
- `skippedFormulas`: total `SKIPPED` outcomes

A record's status is `SUCCESS` only when every selected formula succeeds. Any failed or skipped formula makes the record `FAILED`.

The benchmark test creates 500 records and 10 formulas, evaluates 5,000 formula outcomes, writes 5,000 run-log rows, and enforces a 30-second budget. Full-suite runs measured 940.75-1,264.48 ms of service time and 965.82-1,300.09 ms wall time. The test also verifies that every record and every formula result is present.

## API

All responses use JSON. Request bodies use camelCase; database rows use snake_case. `inputs` is always an array.

Errors use one envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": []
  }
}
```

Error codes include `VALIDATION_ERROR`, `INVALID_JSON`, `PAYLOAD_TOO_LARGE`, `NOT_FOUND`, `VERSION_CONFLICT`, `DEPENDENTS_EXIST`, `DEPENDENCY_CYCLE`, `MISSING_INPUT`, `FORMULA_INVALID`, `DATABASE_UNAVAILABLE`, and `INTERNAL_ERROR`.

### `GET /health`

Request:

```http
GET /health
```

Response `200`:

```json
{
  "status": "ok",
  "database": "connected"
}
```

### `POST /formulas` Create

Request:

```http
POST /formulas
Content-Type: application/json
```

```json
{
  "name": "commission",
  "formulaText": "return EXTERNAL_VAR.amount * EXTERNAL_VAR.rate / 100",
  "createdBy": "admin",
  "sampleData": {
    "amount": 2000,
    "rate": 10
  }
}
```

Response `200`:

```json
{
  "id": 101,
  "uuid": "11111111-1111-4111-8111-111111111111",
  "version": 1,
  "name": "commission",
  "formula_text": "return EXTERNAL_VAR.amount * EXTERNAL_VAR.rate / 100",
  "status": "ACTIVE",
  "created_by": "admin",
  "first_created_at": "2026-10-24T10:00:00.000Z",
  "inserted_at": "2026-10-24T10:00:00.000Z",
  "inputs": [
    "amount",
    "rate"
  ]
}
```

`sampleData` is only used for save-time validation. It is not stored.

### `POST /formulas` Change

Request:

```http
POST /formulas
Content-Type: application/json
```

```json
{
  "uuid": "22222222-2222-4222-8222-222222222222",
  "version": 1,
  "formulaText": "return EXTERNAL_VAR.commission * 0.12"
}
```

Response `200`:

```json
{
  "id": 202,
  "uuid": "22222222-2222-4222-8222-222222222222",
  "version": 2,
  "name": "tax",
  "formula_text": "return EXTERNAL_VAR.commission * 0.12",
  "status": "ACTIVE",
  "created_by": "admin",
  "first_created_at": "2026-10-24T10:00:00.000Z",
  "inserted_at": "2026-10-24T11:00:00.000Z",
  "inputs": [
    "commission"
  ]
}
```

A stale base version returns `409 VERSION_CONFLICT` with the current row in `error.details.current`.

### `POST /formulas/:uuid/deactivate`

Request:

```http
POST /formulas/22222222-2222-4222-8222-222222222222/deactivate
Content-Type: application/json
```

```json
{
  "version": 2,
  "force": true
}
```

Response `200`:

```json
{
  "id": 203,
  "uuid": "22222222-2222-4222-8222-222222222222",
  "version": 3,
  "name": "tax",
  "formula_text": "return EXTERNAL_VAR.commission * 0.12",
  "status": "INACTIVE",
  "created_by": "admin",
  "first_created_at": "2026-10-24T10:00:00.000Z",
  "inserted_at": "2026-10-24T11:05:00.000Z",
  "inputs": [
    "commission"
  ]
}
```

Without `force`, an active dependent returns `400 DEPENDENTS_EXIST` with the impacted formulas. Deactivating an already-inactive formula returns the current row without inserting another version.

### `POST /formulas/:uuid/rollback`

Request:

```http
POST /formulas/22222222-2222-4222-8222-222222222222/rollback
Content-Type: application/json
```

```json
{
  "version": 3,
  "targetVersion": 1,
  "force": false
}
```

Response `200`:

```json
{
  "id": 204,
  "uuid": "22222222-2222-4222-8222-222222222222",
  "version": 4,
  "name": "tax",
  "formula_text": "return EXTERNAL_VAR.commission * 0.18",
  "status": "ACTIVE",
  "created_by": "admin",
  "first_created_at": "2026-10-24T10:00:00.000Z",
  "inserted_at": "2026-10-24T11:10:00.000Z",
  "inputs": [
    "commission"
  ]
}
```

The target must be older than the current version. Rolling back to an inactive target requires `force`.

### `GET /formulas`

Request:

```http
GET /formulas
```

Response `200`:

```json
[
  {
    "id": 101,
    "uuid": "11111111-1111-4111-8111-111111111111",
    "version": 1,
    "name": "commission",
    "formula_text": "return EXTERNAL_VAR.amount * EXTERNAL_VAR.rate / 100",
    "status": "ACTIVE",
    "created_by": "admin",
    "first_created_at": "2026-10-24T10:00:00.000Z",
    "inserted_at": "2026-10-24T10:00:00.000Z",
    "inputs": [
      "amount",
      "rate"
    ]
  }
]
```

The list includes active and inactive current rows, ordered by name then UUID.

### `GET /formulas/:uuid/history`

Request:

```http
GET /formulas/22222222-2222-4222-8222-222222222222/history
```

Response `200`:

```json
[
  {
    "id": 201,
    "uuid": "22222222-2222-4222-8222-222222222222",
    "version": 1,
    "name": "tax",
    "formula_text": "return EXTERNAL_VAR.commission * 0.18",
    "status": "ACTIVE",
    "created_by": "admin",
    "first_created_at": "2026-10-24T10:00:00.000Z",
    "inserted_at": "2026-10-24T10:00:00.000Z",
    "inputs": [
      "commission"
    ]
  },
  {
    "id": 202,
    "uuid": "22222222-2222-4222-8222-222222222222",
    "version": 2,
    "name": "tax",
    "formula_text": "return EXTERNAL_VAR.commission * 0.12",
    "status": "ACTIVE",
    "created_by": "admin",
    "first_created_at": "2026-10-24T10:00:00.000Z",
    "inserted_at": "2026-10-24T11:00:00.000Z",
    "inputs": [
      "commission"
    ]
  }
]
```

Versions are returned oldest first. An unknown UUID returns `404 NOT_FOUND`.

### `GET /formulas/:uuid/impact`

Request:

```http
GET /formulas/11111111-1111-4111-8111-111111111111/impact
```

Response `200`:

```json
[
  {
    "formula": {
      "id": 201,
      "uuid": "22222222-2222-4222-8222-222222222222",
      "version": 1,
      "name": "tax",
      "formula_text": "return EXTERNAL_VAR.commission * 0.18",
      "status": "ACTIVE",
      "created_by": "admin",
      "first_created_at": "2026-10-24T10:00:00.000Z",
      "inserted_at": "2026-10-24T10:00:00.000Z",
      "inputs": [
        "commission"
      ]
    },
    "depth": 1,
    "path": [
      "commission",
      "tax"
    ]
  },
  {
    "formula": {
      "id": 301,
      "uuid": "33333333-3333-4333-8333-333333333333",
      "version": 1,
      "name": "total",
      "formula_text": "return EXTERNAL_VAR.commission + EXTERNAL_VAR.tax",
      "status": "ACTIVE",
      "created_by": "admin",
      "first_created_at": "2026-10-24T10:00:00.000Z",
      "inserted_at": "2026-10-24T10:00:00.000Z",
      "inputs": [
        "commission",
        "tax"
      ]
    },
    "depth": 2,
    "path": [
      "commission",
      "tax",
      "total"
    ]
  }
]
```

An inactive target returns an empty array. An unknown UUID returns `404 NOT_FOUND`.

### `POST /formulas/preview`

Request:

```http
POST /formulas/preview
Content-Type: application/json
```

```json
{
  "record": {
    "amount": 2000,
    "rate": 10
  },
  "formulaUuids": [
    "33333333-3333-4333-8333-333333333333"
  ]
}
```

Response `200`:

```json
{
  "runUuid": "44444444-4444-4444-8444-444444444444",
  "inputRecord": {
    "amount": 2000,
    "rate": 10
  },
  "record": {
    "amount": 2000,
    "rate": 10,
    "commission": 200,
    "tax": 36,
    "total": 236
  },
  "formulas": [
    {
      "uuid": "11111111-1111-4111-8111-111111111111",
      "name": "commission",
      "version": 1,
      "autoAdded": true,
      "status": "SUCCESS",
      "result": 200,
      "steps": {
        "inputs": {
          "amount": 2000,
          "rate": 10
        },
        "formula": "return EXTERNAL_VAR.amount * EXTERNAL_VAR.rate / 100",
        "substituted": "= 2000 * 10 / 100",
        "result": 200
      },
      "error": null,
      "reason": null
    },
    {
      "uuid": "22222222-2222-4222-8222-222222222222",
      "name": "tax",
      "version": 1,
      "autoAdded": true,
      "status": "SUCCESS",
      "result": 36,
      "steps": {
        "inputs": {
          "commission": 200
        },
        "formula": "return EXTERNAL_VAR.commission * 0.18",
        "substituted": "= 200 * 0.18",
        "result": 36
      },
      "error": null,
      "reason": null
    },
    {
      "uuid": "33333333-3333-4333-8333-333333333333",
      "name": "total",
      "version": 1,
      "autoAdded": false,
      "status": "SUCCESS",
      "result": 236,
      "steps": {
        "inputs": {
          "commission": 200,
          "tax": 36
        },
        "formula": "return EXTERNAL_VAR.commission + EXTERNAL_VAR.tax",
        "substituted": "= 200 + 36",
        "result": 236
      },
      "error": null,
      "reason": null
    }
  ]
}
```

Formula failures still return `200`. A missing record field returns `400 MISSING_INPUT` before evaluation. An unknown requested UUID returns `404 NOT_FOUND`.

### `POST /formulas/preview/bulk`

Request:

```http
POST /formulas/preview/bulk
Content-Type: application/json
```

```json
{
  "records": [
    {
      "amount": 2000,
      "rate": 10
    }
  ],
  "formulaUuids": [
    "11111111-1111-4111-8111-111111111111"
  ]
}
```

Response `200`:

```json
{
  "results": [
    {
      "recordIndex": 0,
      "runUuid": "55555555-5555-4555-8555-555555555555",
      "record": {
        "amount": 2000,
        "rate": 10,
        "commission": 200
      },
      "formulas": [
        {
          "uuid": "11111111-1111-4111-8111-111111111111",
          "name": "commission",
          "version": 1,
          "autoAdded": false,
          "status": "SUCCESS",
          "result": 200,
          "steps": {
            "inputs": {
              "amount": 2000,
              "rate": 10
            },
            "formula": "return EXTERNAL_VAR.amount * EXTERNAL_VAR.rate / 100",
            "substituted": "= 2000 * 10 / 100",
            "result": 200
          },
          "error": null,
          "reason": null
        }
      ],
      "status": "SUCCESS"
    }
  ],
  "summary": {
    "totalRecords": 1,
    "totalFormulas": 1,
    "totalMs": 9.4,
    "avgMsPerRecord": 9.4,
    "failedRecords": 0,
    "failedFormulas": 0,
    "skippedFormulas": 0
  }
}
```

The bulk body accepts 1 to 500 records. Malformed bodies, missing inputs, and unknown requested UUIDs are rejected for the whole request before anything runs. Formula failures are isolated per record and reported in the metrics.

## Tests

```bash
npm test
npm run typecheck
```

The suite contains 115 tests. It covers the required cases explicitly:

| Required area | Test coverage |
| --- | --- |
| Rounding | `executePreview rounds 0.1 plus 0.2 to 0.3 at the output boundary`; `executePreview rounds output results while dependents receive raw values` |
| Dependency ordering | `computeLevels orders a chain from its dependencies`; `executePreview runs levels in dependency order with bounded concurrency`; the worked-example endpoint test |
| Loop detection | `findCyclePath returns the exact cycle path`; `POST /formulas rejects a cycle with the full path` |
| Timeout | `times out and recovers the worker`; `executePreview marks timeouts FAILED and skips dependents` |
| Skipped dependents | `executePreview isolates failures and skips transitive dependents`; the single and bulk failure endpoint tests |
| Concurrency conflict | `POST /formulas serializes simultaneous changes on the same base version`, which asserts one `200` and one `409`; `saveRecord maps a duplicate version to a conflict with the current row` |
| Save create | `saveRecord creates a generated version 1 formula` |
| Save change | `saveRecord changes only sent fields and inserts the next version` |

Additional coverage includes as-of snapshots, reverse-order creation, bulk validation and metrics, 500-row log chunking, request errors with no logs, and the 500 x 10 performance budget.

## Assumptions

- MySQL 8 or newer is available. The application relies on window functions, recursive CTEs, `JSON_TABLE`, and JSON columns.
- Formula references use dot notation, `EXTERNAL_VAR.<name>`. Bracket notation and `EXTERNAL_VAR.CODE` are not treated as inputs.
- Names are case-sensitive. Active names must be unique; inactive names can be reused. A formula dependency takes precedence over a same-named record field.
- Omitting `formulaUuids` means every active formula. An empty array means no formulas. Dependencies of a requested subset are added automatically.
- Missing record fields are rejected before evaluation. During save-time sample validation, missing formula dependencies are supplied as `1`.
- Successful formula results shadow same-named record fields in the final record.
- Non-finite numeric results are invalid. Successful finite numbers are rounded to two decimals only at the response and log boundary.
- The default timeout is 500 ms per formula. A timeout marks the formula `FAILED`, not the whole request.
- `asOf` is inclusive, uses the highest row at or before the timestamp, and then keeps only `ACTIVE` rows. A future timestamp behaves like the current state.
- Bulk records are independent. One failed record does not stop the others. A malformed or missing-input record rejects the whole request before execution.
- The HTTP body limit is 5 MB. Bulk record count is capped at 500; individual record size is not separately capped.
- Run logs and formula versions are append-only and retained. There is no automatic retention job in this assignment.
- Tests use a separate disposable database and unique names. They do not delete rows.

## Written Answer

See `WRITTEN_ANSWER.md`.
