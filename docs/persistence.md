# Persistence

Agent, Run, and Trace records live in the backend process (`apps/backend`). The stores are modules in that process. They are not a separate service, and they are not part of the agent service or the mock shop.

This is epic [#64](https://github.com/mesagroup/MESA-AgentFailureLab/issues/64). Agent CRUD ([#50](https://github.com/mesagroup/MESA-AgentFailureLab/issues/50)) shipped in [#71](https://github.com/mesagroup/MESA-AgentFailureLab/pull/71). Run and Trace persistence ([#74](https://github.com/mesagroup/MESA-AgentFailureLab/issues/74)) uses the same Postgres and the same migration runner. The Run and Trace tables finish the schema work in [#73](https://github.com/mesagroup/MESA-AgentFailureLab/issues/73). `001_agents.sql` is unchanged.

Each document has one JSON Schema. Writes call the matching function from `@mesa/shared/validate`:

| Document | Schema | Validator |
| --- | --- | --- |
| Agent | `packages/shared/schemas/agent.schema.json` | `validateAgent` |
| Run | `packages/shared/schemas/run.schema.json` | `validateRun` |
| Trace | `packages/shared/schemas/trace.schema.json` | `validateTrace` |

These files are not edited by the store. SQL stores the document as `jsonb`. It does not restate each field.

## Why Postgres, and why memory remains

Agents, runs, and traces have to survive a process restart and a redeploy. The lab's hosted target is one Postgres database on Render, selected with `DATABASE_URL`. The backend talks to it with `pg` (node-postgres). There is no Prisma and no second service. Runs and traces are not a second database.

CI and a laptop without a database still have to run `pnpm build` and `pnpm test`. `AgentStore` and `RunStore` each have an in-memory implementation. `DATABASE_URL` empty means both implementations. `GET /health` then reports `agent_store: "memory"` and `run_store: "memory"`. A restart drops those rows. The agent store seeds `reference-shop` again. The run store does not seed anything.

`instance.base_url` and `test_instance.base_url` are the agent runtime (port 3002 for the reference agent). They are not the mock shop.

The harness runner still loads `packages/shared/examples/agent-reference-stub.json` through `loadReferenceAgent()` when it executes tasks. The CRUD store does not choose which agent a run uses.

## Architecture

```text
openAgentStore(env)          openRunStore(env)
  DATABASE_URL blank           DATABASE_URL blank
    -> MemoryAgentStore          -> MemoryStore (empty)
  DATABASE_URL set             DATABASE_URL set
    -> PostgresAgentStore        -> PostgresRunStore
       migrate() then seed          migrate() (no seed)
buildApp({ agents, store })
  registerAgentRoutes
  GET /runs, GET /traces, POST /runs, POST /attacker/jury-case
```

Both openers read the same variable. A blank or missing `DATABASE_URL` is memory for both. A URL is Postgres for both. `src/index.ts` opens the agent store first (migrate, then seed), then the run store (migrate). The second migrate sees the files already recorded and does not run them again. On shutdown the process closes the run store, then the agent store.

`src/agents/store.ts` defines `AgentStore`. Both agent implementations honor it.

| Method | Behavior |
| --- | --- |
| `list()` | Agents ordered by `created_at`, then `agent_id` |
| `get(agentId)` | One agent, or absent |
| `create(body)` | Fill missing server fields, `validateAgent`, insert. Conflict if the id exists |
| `replace(agentId, body)` | 404 if absent. Server sets `updated_at`. Validate, then replace the document |
| `delete(agentId)` | 409 for `reference-shop`. 404 if another id is absent |
| `seedIfMissing()` | Insert the reference fixture only when `reference-shop` is absent |
| `close()` | End the pool, or a no-op for memory |

`src/agents/open.ts` reads `DATABASE_URL`. A blank or missing value returns `MemoryAgentStore`, which seeds in its constructor. A URL returns `PostgresAgentStore`, applies migrations, then seeds. `src/persistence/open.ts` does the same selection for runs and traces and does not seed. `src/index.ts` does both before `listen`, and closes both stores when the process closes the Fastify app.

`MemoryAgentStore` is a `Map`. Records are cloned on the way in and out. `PostgresAgentStore` uses a pool of at most 5 connections and a 10 second connect timeout. A URL with `sslmode=require`, or a host ending in `.render.com`, uses TLS with `rejectUnauthorized: false` (Render's public certificate). Compose and other local URLs stay non-TLS.

Writes that fail `validateAgent` throw `AgentValidationError` (HTTP 400). A duplicate id throws `AgentConflictError` (HTTP 409). A missing id throws `AgentNotFoundError` (HTTP 404). Deleting `reference-shop` throws `ProtectedAgentError` (HTTP 409).

### RunStore

`src/persistence/store.ts` defines the interface. `MemoryStore` (`src/persistence/memory.ts`) and `PostgresRunStore` (`src/persistence/postgres.ts`) both honor it. Existing imports of `RunStore`, `MemoryStore`, and `ContractError` from `src/persistence/memory.ts` still resolve. The agent service scripts construct `MemoryStore` and pass it into the harness. They do not open Postgres.

| Method | Behavior |
| --- | --- |
| `saveRun(run)` | `validateRun`, then insert or replace by `run_id`. A replace keeps the first-insert time |
| `getRun(runId)` | One run, or absent |
| `listRuns()` | First-save order, then `run_id` |
| `listRunsByAgent(agentId)` | That agent's runs, oldest first. This is the `runs (agent_id, created_at)` lookup. It is not a separate HTTP route |
| `saveTrace(trace)` | `validateTrace`, then insert or replace by `trace_id`. A replace keeps the first-insert time and refreshes `started_at` from the document |
| `getTrace(traceId)` | One trace, or absent |
| `listTraces()` | First-save order, then `trace_id` |
| `listTracesByRun(runId)` | Traces for that run, oldest first. This is the `traces (run_id)` lookup. It is not a separate HTTP route |
| `close()` | End the pool, or a no-op for memory |

`MemoryStore` is two `Map`s. Records are cloned on the way in and out. Saving an id that is already present replaces the value and does not move it in the map. `PostgresRunStore` uses the same pool settings as agents (at most 5 connections, 10 second connect timeout, TLS rules above).

A write that fails `validateRun` or `validateTrace` throws `ContractError` and stores nothing. The harness turns that into HTTP 500 on `POST /runs` and `POST /attacker/jury-case`, which is the same status the in-memory store already produced. `GET` of a missing id is still 404 `{ "error": "not_found", "message": "No run …" }` or `"No trace …"`.

There is no delete method and no foreign key. Deleting an agent does not delete runs or traces that name it. Saving a trace does not require the run row to exist. That matches the memory maps.

The store does not interpret the documents. `outcome.verifier` is still written only by the deterministic verifier. `fault.labels` are still written only by the injector or the attacker. `diagnosis` stays null until Grok, and Grok still does not write the verifier or the labels. ADR-001 is unchanged.

## Data model

File: `apps/backend/migrations/001_agents.sql`.

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agents (
  agent_id text PRIMARY KEY,
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
```

`document` is the Agent object the API returns. `created_at` and `updated_at` copy the same timestamps so `list()` can sort without parsing JSON. The API response is the document, not a projection of the columns.

`schema_migrations.version` is the SQL file name (`001_agents.sql`).

### Runs

File: `apps/backend/migrations/002_runs.sql`. Do not edit `001_agents.sql` to add this table.

```sql
CREATE TABLE IF NOT EXISTS runs (
  run_id text PRIMARY KEY,
  agent_id text NOT NULL,
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runs_agent_id_created_at_idx
  ON runs (agent_id, created_at, run_id);

CREATE INDEX IF NOT EXISTS runs_created_at_run_id_idx
  ON runs (created_at, run_id);
```

`document` is the Run object inside `GET /runs`. The Run schema has no `created_at`. The column is the first insert time, copied so the store can order without parsing JSON. A later `saveRun` for the same `run_id` replaces `document` and `agent_id` and leaves `created_at` alone, so the row does not jump in the store list. `agent_id` is copied from the document for the agent lookup. The API response does not include the column.

`listRuns()` orders by `created_at`, then `run_id` (oldest first). `GET /runs` passes that list through `sessionView`, which reverses it, so the dashboard snapshot is newest start first. `runs_agent_id_created_at_idx` serves `listRunsByAgent` (`WHERE agent_id = ? ORDER BY created_at, run_id`). `runs_created_at_run_id_idx` serves `listRuns()`. `GET /runs/:runId` uses the primary key and returns the Run document alone.

### Traces

File: `apps/backend/migrations/003_traces.sql`.

```sql
CREATE TABLE IF NOT EXISTS traces (
  trace_id text PRIMARY KEY,
  run_id text NOT NULL,
  agent_id text NOT NULL,
  document jsonb NOT NULL,
  started_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS traces_run_id_created_at_idx
  ON traces (run_id, created_at, trace_id);

CREATE INDEX IF NOT EXISTS traces_created_at_trace_id_idx
  ON traces (created_at, trace_id);
```

`document` is the Trace object `GET /traces` returns. `run_id`, `agent_id`, and `started_at` are copied from that document. `started_at` is the attempt's own clock (a required Trace field). `created_at` is the first insert and is not a Trace field. A later save refreshes `started_at` from the new document and keeps `created_at`.

`traces_run_id_created_at_idx` serves `listTracesByRun` (`WHERE run_id = ? ORDER BY created_at, trace_id`). `traces_created_at_trace_id_idx` serves `GET /traces`. `GET /traces/:traceId` uses the primary key.

Neither table references `agents` or the other table. Runs are not stored inside `agents.document`.

## Migrations and bootstrap

Migrations run inside the backend process when it starts and `DATABASE_URL` is set. There is no separate migrate command. The memory store does not run SQL.

The runner is `applyMigrations` in `src/agents/postgres.ts`. `PostgresAgentStore.migrate()` and `PostgresRunStore.migrate()` both call it:

1. Creates `schema_migrations` if needed.
2. Reads `apps/backend/migrations/*.sql` in name order (`001_agents.sql`, `002_runs.sql`, `003_traces.sql`). From the compiled image that directory is `/app/migrations` (the Dockerfile copies it next to `dist/`).
3. Skips a file whose name is already in `schema_migrations`.
4. Runs the file in a transaction, then records the file name. A UTF-8 BOM is stripped and CRLF is normalized to LF before the script runs, so a Windows checkout applies the same statements.

The statements also use `IF NOT EXISTS`, so applying a file by hand is safe. Starting the process twice does not insert a second seed row and does not rewrite an existing agent. It also does not duplicate run or trace rows. `002_runs.sql` and `003_traces.sql` are applied on an empty database and skipped once their names are recorded.

Do not edit a file after it has been applied in a shared database. The runner will not apply it again. Add the next numbered file instead.

If Postgres is unreachable, startup throws and the process exits. The message says to check `DATABASE_URL`. It does not print the URL.

## Seed lifecycle

The fixture is `packages/shared/examples/agent-reference-stub.json`. Its `agent_id` is `reference-shop`.

| Event | Memory | Postgres |
| --- | --- | --- |
| Boot, id absent | Insert the fixture | `INSERT … ON CONFLICT DO NOTHING` |
| Boot, id present | Leave the row, including a `PUT` that renamed it | Same |
| `DELETE /agents/reference-shop` | 409, row kept | 409, row kept |
| Process restart | New empty map, then seed. Other agents are gone | Rows stay, including agents other than the seed |
| `seedIfMissing()` again in the same process | No overwrite | No overwrite |

There is no `POST /internal/agents/reset`. The architect note on #50 marked that route optional, and that route is still absent. Runs and traces are not seeded. A fresh memory store is empty. A fresh Postgres database has the tables and no run or trace rows.

A local wipe of Postgres data is `docker compose down -v`, which deletes the `mesa-pgdata` volume. The next start runs migrations on an empty database and seeds `reference-shop` because that id is missing.

`deleteAllRowsForTests` exists on `PostgresAgentStore` (agents) and on `PostgresRunStore` (runs, then traces) for the test suites. Neither is an HTTP route.

## Retention

Nothing in this store expires. There is no TTL, no row cap, and no purge job.

| Event | Memory | Postgres |
| --- | --- | --- |
| Process restart | Runs and traces are gone. Agents other than the reseeded `reference-shop` are gone | Every run, trace, and agent row stays |
| `DELETE /agents/:id` (not the seed) | That agent row is gone. Runs and traces that name it stay | Same |
| Save the same `run_id` or `trace_id` again | Document replaced. List position unchanged | Document replaced. `created_at` unchanged, so list position stays |
| `docker compose down` | The process is gone | The `mesa-pgdata` volume keeps agents, runs, and traces |
| `docker compose down -v` | The process is gone | The volume is deleted. The next start migrates an empty database and seeds `reference-shop` only |

There is no `DELETE /runs` or `DELETE /traces`. A jury reset of run history is a volume wipe, or a manual `DELETE` against `runs` and `traces`. Backup and a written reset procedure are [#75](https://github.com/mesagroup/MESA-AgentFailureLab/issues/75), not this store.

`created_at` on `runs` and `traces` is an order column. It is not a retention clock. Rows are not deleted because they are old.

## API reference

No auth. Bodies are JSON. `Content-Type: application/json`.

`instance.base_url` in the examples is the agent runtime on port 3002, not the shop.

### `GET /health`

200. Existing harness health, plus `agent_store`.

```json
{
  "status": "ok",
  "service": "backend",
  "role": "harness",
  "agent_store": "memory",
  "run_store": "memory"
}
```

`agent_store` and `run_store` are `"postgres"` when `DATABASE_URL` is set. The rest of the health body is unchanged (`contract_version`, `mock_base_url`, `grok_forbidden_write_paths`).

### `GET /runs`, `GET /runs/:runId`, `GET /traces`, `GET /traces/:traceId`

`GET /traces` is `{ "traces": [ ... ] }`, oldest first. One trace is the Trace document. `GET /runs/:runId` is the Run document alone.

`GET /runs` is the dashboard snapshot from `src/harness/session.ts` ([#79](https://github.com/mesagroup/MESA-AgentFailureLab/pull/79)). The store still supplies the documents. `sessionView` reverses the store order and attaches links and counts. It does not score the run. `outcome.verifier` on `trace_links` is copied from the stored trace.

```json
{
  "runs": [],
  "trace_links": [],
  "counts": {
    "scope": "harness_session",
    "agents": 1,
    "runs": 0,
    "queued": 0,
    "running": 0,
    "passed": 0,
    "failed": 0,
    "error": 0
  }
}
```

`runs` is newest start first. Each element is a Run document. The SQL `created_at` column is not added to that JSON. `trace_links[i]` describes `runs[i]`. `counts.scope` stays `harness_session`. With `DATABASE_URL` set, `counts` tallies the Postgres rows this process can see, including rows written before the current process started. Without it, a restart drops the runs and the counts go back to zero (the agent seed remains, so `counts.agents` is at least 1).

404 for an unknown id:

```json
{ "error": "not_found", "message": "No run missing-run" }
```

`POST /runs` and `POST /attacker/jury-case` still return the same bodies. They write through whichever store `DATABASE_URL` selected. `POST /diagnose` on the agent service is not this store. Grok still writes `diagnosis` only, and only on the trace it is given. The harness does not call Grok.

### `GET /agents`

200. `{ "agents": [ ... ] }`, ordered by `created_at` then `agent_id`. After a fresh boot the list is the seed only.

```json
{
  "agents": [
    {
      "agent_id": "reference-shop",
      "name": "Reference shop assistant",
      "created_at": "2026-11-04T09:00:00.000Z",
      "updated_at": "2026-11-04T09:00:00.000Z"
    }
  ]
}
```

The real seed document also includes `description`, `instance`, `test_instance`, `traces`, `docs`, and `tasks`. The snippet above shows the identity fields. `GET /agents/reference-shop` returns the full fixture.

### `GET /agents/:agent_id`

200. The Agent document.

404 when the id is absent:

```json
{ "error": "not_found", "message": "No agent missing-agent" }
```

### `POST /agents`

201. The stored Agent.

Omit `agent_id`, `created_at`, or `updated_at` and the server fills them. `agent_id` becomes a UUID. The two timestamps are the same instant. A body that already includes those fields is kept, then validated. If the id exists, the response is 409 and nothing is written.

Request (server assigns the three fields):

```json
{
  "name": "External shop assistant",
  "description": "Registrant-supplied endpoint for one search task.",
  "instance": {
    "kind": "external",
    "base_url": "http://127.0.0.1:3002",
    "runtime": "grok"
  },
  "test_instance": {
    "base_url": "http://127.0.0.1:3002",
    "runtime": "grok"
  },
  "traces": { "store": "inline", "path_or_url": "external-shop" },
  "docs": {
    "prompt_summary": "Complete the task with the shop tools.",
    "tools": [
      { "name": "search_products", "description": "GET /products?q= — search the catalog." }
    ],
    "constraints": ["Use only the mock shop tools."],
    "config_notes": "instance.base_url is the agent runtime, not the shop."
  },
  "tasks": [
    {
      "task_id": "T1",
      "title": "Search and open a product",
      "prompt": "Search the catalog for a ceramic mug.",
      "success_test": {
        "type": "verifier_checks",
        "checks": [
          {
            "name": "catalog_read",
            "description": "The session recorded at least one catalog search."
          }
        ]
      }
    }
  ]
}
```

201 response (ids and timestamps differ per call):

```json
{
  "agent_id": "4f1c0b2e-7a0e-4c1d-9b3a-6e8d2f0a1c55",
  "name": "External shop assistant",
  "created_at": "2026-11-04T15:00:00.000Z",
  "updated_at": "2026-11-04T15:00:00.000Z"
}
```

The response is the full document, including the fields sent in the request.

400 when the document is not a JSON object or fails the schema. Example body `{ "name": "incomplete" }`:

```json
{
  "error": "invalid_agent",
  "message": "/ must have required property 'description'; / must have required property 'instance'; / must have required property 'test_instance'; / must have required property 'traces'; / must have required property 'docs'; / must have required property 'tasks'",
  "errors": [
    "/ must have required property 'description'",
    "/ must have required property 'instance'",
    "/ must have required property 'test_instance'",
    "/ must have required property 'traces'",
    "/ must have required property 'docs'",
    "/ must have required property 'tasks'"
  ]
}
```

`message` is `errors` joined with `"; "`. The exact Ajv strings follow the schema.

409 when `agent_id` is already stored:

```json
{ "error": "conflict", "message": "Agent reference-shop already exists." }
```

Fastify's JSON parser returns its own 400 for a body that is not JSON. That happens before this route.

### `PUT /agents/:agent_id`

200. The replaced document.

The path is the id. The server sets `updated_at` and ignores a client `updated_at`. If `created_at` is omitted, the stored value is kept. If `created_at` is present, it must be a valid date-time and it replaces the stored one. If the body contains `agent_id` and it differs from the path, the response is 400 (`agent_id must be <path>.`).

404 when the id is absent:

```json
{ "error": "not_found", "message": "No agent does-not-exist" }
```

400 uses the same `invalid_agent` body as `POST`.

`PUT /agents/reference-shop` is allowed. The next boot will not overwrite that row.

### `DELETE /agents/:agent_id`

204. Empty body.

404 when the id is absent and it is not the seed:

```json
{ "error": "not_found", "message": "No agent does-not-exist" }
```

409 for the seed, whether or not a row is present. The row is not removed:

```json
{
  "error": "conflict",
  "message": "Agent reference-shop is the demo seed and cannot be deleted."
}
```

## Environment

| Variable | Who reads it | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | backend, at startup | Postgres URL for agents, runs, and traces. Empty or unset means both stores stay in memory. Compose sets `postgres://mesa:mesa@mesa-postgres:5432/mesa`. Render sets it from `fromDatabase.connectionString`. Do not commit a real URL. Turbo passes this variable into `pnpm dev` |
| `TEST_DATABASE_URL` | `apps/backend` tests only | Disposable database for `test/agents-postgres.test.ts` and `test/runs-postgres.test.ts`. Unset skips those files. CI leaves it unset. The agent file uses schema `mesa_agent_test` and does not write `public.agents`. The run file drops and recreates schema `mesa_run_test` only, then deletes rows there. It does not write `public.runs` or `public.traces`. A host containing `.render.com` is refused before connect. Turbo passes this variable into `pnpm test` |

`apps/backend/.env.example` documents `DATABASE_URL` and leaves it commented out. Compose's `environment` block wins over a copied `.env`.

## Local runbook

### Without a database

From the repo root:

```bash
pnpm install
pnpm dev:backend
```

`GET http://127.0.0.1:3001/health` reports `agent_store` and `run_store` as `memory`. `GET /agents/reference-shop` returns the seed. `GET /runs` is a snapshot with empty `runs` and `trace_links` until something calls `POST /runs`. Other agents, and every run and trace, disappear when the process stops.

Windows PowerShell:

```powershell
pnpm install
pnpm dev:backend
Invoke-RestMethod http://127.0.0.1:3001/health
Invoke-RestMethod http://127.0.0.1:3001/agents/reference-shop
```

### Docker Compose (Postgres)

Docker Desktop must be running. From the repo root:

```bash
docker compose up --build
```

This starts the four web processes and Postgres 16 (`mesa-postgres`) on the `mesa` network. The backend waits until `pg_isready` succeeds, then migrates and seeds. Published ports: 3000, 3001, 3002, 8787, and Postgres on `127.0.0.1:5432`.

User, password, and database name are `mesa`. That password is a local default, not a production secret.

`GET /health` on the backend reports `agent_store` and `run_store` as `postgres`.

Agent, run, and trace rows live in the `mesa-pgdata` volume. `docker compose down` keeps the volume. `docker compose down -v` deletes it. The next `up` migrates and seeds `reference-shop` again. Runs and traces are not seeded, so `GET /runs` has empty `runs` and `trace_links` after a volume wipe until the next batch. `counts.agents` is 1 because the seed is back.

Windows PowerShell, from the repo root:

```powershell
docker compose up --build
Invoke-RestMethod http://127.0.0.1:3001/health
Invoke-RestMethod http://127.0.0.1:3001/agents/reference-shop
docker compose down
```

To delete the agent data as well:

```powershell
docker compose down -v
```

Run the backend on the host against the published Postgres port (Compose Postgres already up):

```powershell
$env:DATABASE_URL = "postgres://mesa:mesa@127.0.0.1:5432/mesa"
pnpm dev:backend
```

Bash:

```bash
export DATABASE_URL=postgres://mesa:mesa@127.0.0.1:5432/mesa
pnpm dev:backend
```

`docker compose config` must stay valid. CI runs that check. It does not start the database.

The backend image also boots with no `DATABASE_URL` (CI's `docker run` health check). It uses the memory stores and answers `GET /health`.

To see a run survive a restart, start Compose (or the host command above), `POST /runs` with `{ "agent_id": "reference-shop", "phase": "baseline", "task_ids": ["T1"] }`, stop the backend process, start it again with the same `DATABASE_URL`, and `GET /runs`. `agent_id` is required and must already be in the agent registry. The run and its trace are still there. With no `DATABASE_URL`, that `GET` is empty after the restart.

## Postgres-only tests

`apps/backend/test/agents-postgres.test.ts` exercises `PostgresAgentStore`: migrate twice, create, conflict, protected delete, a second pool that still sees the row, and the HTTP routes on that store.

`apps/backend/test/runs-postgres.test.ts` exercises `PostgresRunStore`: drop and recreate schema `mesa_run_test`, migrate twice (the second call skips files already recorded), the lookup indexes, a rejected invalid run, a run saved with its trace, a replace that keeps `created_at`, a second pool that still sees both documents, and `GET /runs` / `GET /traces` on that store.

Both files skip when `TEST_DATABASE_URL` is unset, which is the CI default. `pnpm test` then still passes. Set the variable to a disposable local database to run them. Do not point it at Render. A URL whose host contains `.render.com` throws before a connection is opened.

Postgres 16 matches Compose (`postgres:16-alpine`) and the Render blueprint. From the repo root, with that server listening on `127.0.0.1:5432` (user, password, and database `mesa`):

```bash
export TEST_DATABASE_URL=postgres://mesa:mesa@127.0.0.1:5432/mesa
pnpm --filter @mesa/backend test
```

Windows PowerShell:

```powershell
$env:TEST_DATABASE_URL = "postgres://mesa:mesa@127.0.0.1:5432/mesa"
pnpm --filter @mesa/backend test
```

Clear the variable in the same PowerShell session when you want the skip again:

```powershell
Remove-Item Env:TEST_DATABASE_URL
pnpm --filter @mesa/backend test
```

Bash:

```bash
unset TEST_DATABASE_URL
pnpm --filter @mesa/backend test
```

Root `pnpm test` forwards `TEST_DATABASE_URL` (see `turbo.json`).

In-memory coverage always runs: `apps/backend/test/agents.test.ts` for agents, `apps/backend/test/runs.test.ts` for runs and traces. The migration runner test normalizes a BOM and CRLF (`\r\n`) so a Windows checkout does not change the SQL that reaches Postgres.

The Postgres tests use the same `pg` driver as production, against a real server, instead of an embedded engine. They stay out of CI so `pnpm test` does not need a database.

## Render (review before apply)

`render.yaml` adds one database and one env var. Yuri reviews this before the next Blueprint sync. Do not apply it until that review is done.

| Piece | Value | Why it is here |
| --- | --- | --- |
| Database name | `mesa-postgres` | Same environment as the demo web services (`mesa-agent-failure-lab` / `demo`) |
| Plan | `free` (0.1 CPU / 256 MB) | Matches the free web services. If the workspace rejects free Postgres, change the plan to `0.1c-256mb` before applying. Free Postgres may also expire |
| Region | `frankfurt` | Same region as the web services |
| `postgresMajorVersion` | `"16"` | Matches the Compose image `postgres:16-alpine`. This cannot be changed after create |
| `databaseName` / `user` | `mesa` / `mesa` | Render may suffix the database name. The connection string carries the real name. These cannot be changed after create |
| `DATABASE_URL` | `fromDatabase` / `connectionString` | Private-network URL. The password is not in git |

Confirm the free `mesa-backend` service can open that private-network host. `connectionString` is not a public URL. If the free instance cannot use the private network, the backend plan has to change. This file does not change the web service plan.

A Blueprint sync refreshes `DATABASE_URL` from the database. `XAI_API_KEY` stays `sync: false`.

The same database holds agents, runs, and traces once the backend from this tree is deployed and `DATABASE_URL` is set. `render.yaml` is not changed further here. Provisioning and the Blueprint review stay in [#72](https://github.com/mesagroup/MESA-AgentFailureLab/issues/72), with Yuri (diamanti-sg). Do not apply the Blueprint until that review is done.

## Left for #75 (cutover, seed, backup)

[#75](https://github.com/mesagroup/MESA-AgentFailureLab/issues/75) is still open. This store does not do that work.

- Cutover from a memory process to Postgres does not import runs or traces that existed only in that process. They are already gone when the process stops. After `DATABASE_URL` is set, new runs are written to Postgres. Old memory rows are not copied.
- The `reference-shop` seed is unchanged: insert on boot when the id is missing, never overwrite, 409 on delete. Runs and traces have no seed.
- There is no backup command, no restore command, and no jury reset route. `docker compose down -v` is the local wipe. A hosted backup note still has to be written.

Not in this work: auth, multi-tenant isolation, a dedicated store service, edits to the JSON Schemas, or moving agent execution into the backend. The shop catalog is still in memory. `POST /internal/reset` on the shop is unchanged. The frontend Runs and Trace pages are still placeholders and do not call these routes yet. `POST /diagnose` is still the agent service, and it still does not write `outcome.verifier` or `fault.labels`.
