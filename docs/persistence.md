# Persistence

Agent, Run, and Trace records live in the backend process (`apps/backend`). The stores are modules in that process. They are not a separate service, and they are not part of the agent service or the mock shop.

Stored traces can be diagnosed explicitly through
[`POST /traces/:traceId/diagnose`](../apps/backend/README.md#diagnose-a-stored-trace).
The service produces `diagnosis`; the backend validates and persists only that
field with a compare-and-set against the original document. Memory and Postgres
reject a stale update; Postgres performs the comparison in the same SQL UPDATE.
The operation preserves the trace's first-insert time, associated Run and all
protected fields. No migration is needed. With Postgres the diagnosis survives
a new pool/process and is included in normal backups. Memory is still transient.

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

CI and a laptop without a database still have to run `pnpm build` and `pnpm test`. `AgentStore` and `RunStore` each have an in-memory implementation. `DATABASE_URL` empty means both implementations. `GET /health` then reports `agent_store: "memory"` and `run_store: "memory"`. A restart drops those rows. The agent store seeds `reference-shop` and `external-library` again. The run store then inserts the demo Run/Trace pairs when those ids are missing. Other runs and traces stay gone after a memory restart.

`instance.base_url` and `test_instance.base_url` are the agent runtime. For `reference-shop` that is agentservice. For `external-library` that is the library desk. They are not the mock. The mock is `world.base_url`. The process resolves both from environment variables. See [seed-endpoints.md](seed-endpoints.md).

`POST /runs` loads the agent from this store. The jury case still starts from `loadReferenceAgent()` unless the caller passes another agent.

## Architecture

```text
openAgentStore(env)          openRunStore(env)
  DATABASE_URL blank           DATABASE_URL blank
    -> MemoryAgentStore          -> MemoryStore (empty until demo seed)
  DATABASE_URL set             DATABASE_URL set
    -> PostgresAgentStore        -> PostgresRunStore
       migrate() then seed          migrate(); index.ts then seedDemoRunsAndTraces
buildApp({ agents, store })
  registerAgentRoutes
  GET /runs, GET /traces, POST /runs, POST /attacker/jury-case
```

Both openers read the same variable. A blank or missing `DATABASE_URL` is memory for both. A URL is Postgres for both. `src/index.ts` opens the agent store first (migrate, then seed), then the run store (migrate), then `seedDemoRunsAndTraces` (insert-if-missing). The second migrate sees the files already recorded and does not run them again. On shutdown the process closes the run store, then the agent store.

Backup, restore, and jury reset are command-line scripts in `src/persistence/cli.ts` (`db:export`, `db:import`, `db:reset`). They are not HTTP routes. See [Backup and restore](#backup-and-restore), [Jury reset](#jury-reset), and [Cutover](#cutover).

`src/agents/store.ts` defines `AgentStore`. Both agent implementations honor it.

| Method | Behavior |
| --- | --- |
| `list()` | Agents ordered by `created_at`, then `agent_id`. A document that fails `validateAgent` is logged and omitted |
| `get(agentId)` | One agent, or absent. A present document that fails `validateAgent` throws |
| `create(body)` | Fill missing server fields, `validateAgent`, insert. Conflict if the id exists |
| `replace(agentId, body)` | 404 if the id is absent. Server sets `updated_at`. Validate, then replace the document. An invalid stored document is still replaced. `created_at` is kept when the body omits it and the stored value is a date-time |
| `delete(agentId)` | 409 for `reference-shop` and `external-library`. 404 if another id is absent |
| `seedIfMissing()` | Insert each demo fixture when that id is absent. Rewrite a row when its document fails `validateAgent` or its `updated_at` is earlier than that fixture. A valid row at the same age or newer stays |
| `upsertImported(agent)` | Backup import. Insert the document, or replace it and keep the stored `created_at`. An invalid stored document is still replaced. Not an HTTP route |
| `deleteAgentsExceptSeed()` | Delete every agent except `reference-shop` and `external-library`. Not an HTTP route |
| `close()` | End the pool, or a no-op for memory |

`src/agents/open.ts` reads `DATABASE_URL`. A blank or missing value returns `MemoryAgentStore`, which seeds in its constructor. A URL returns `PostgresAgentStore`, applies migrations, then seeds. `src/persistence/open.ts` does the same selection for runs and traces and does not seed. `src/index.ts` does both before `listen`, and closes both stores when the process closes the Fastify app.

`MemoryAgentStore` is a `Map`. Records are cloned on the way in and out. `PostgresAgentStore` uses a pool of at most 5 connections and a 10 second connect timeout. Render's internal URL (`fromDatabase` property `connectionString`) has no `.render.com` host and no `sslmode`. TLS is not required on that private network, so the pool leaves the string alone. Compose (`postgres://mesa:mesa@mesa-postgres:5432/mesa`) is the same. The external URL requires TLS. A host containing `.render.com`, or any URL with `sslmode=require`, uses TLS with `rejectUnauthorized: false`. `sslmode` is removed so node-postgres does not verify the CA. Internal certificates are self-signed, so `verify-ca` and `verify-full` are not used. Laptop `db:import` uses the external URL. The running service on Render uses the internal one.

Writes that fail `validateAgent` throw `AgentValidationError` (HTTP 400). A duplicate id throws `AgentConflictError` (HTTP 409). A missing id throws `AgentNotFoundError` (HTTP 404). Deleting `reference-shop` or `external-library` throws `ProtectedAgentError` (HTTP 409).

`list()` does not throw when a stored document fails the Agent schema. It skips that row and writes a warning. `GET /agents` and `GET /runs` stay up when one agent is stale. `GET /agents/:agent_id` for that id still fails until the row is replaced. `db:export` uses `list()`, so an invalid agent is left out of the file. A later import that contains a valid copy of that id overwrites the row.

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
| `listRunRecords()` / `listTraceRecords()` | Same order as the lists above, plus the first-insert time. That time is not a Run or Trace field |
| `upsertImportedRun` / `upsertImportedTrace` | Backup import. The first insert stores the file's `created_at`. A later import keeps that time and replaces the document. Not an HTTP route |
| `deleteAllRunsAndTraces()` | Delete every trace, then every run. Agents stay. Not an HTTP route. `db:reset` calls this |
| `close()` | End the pool, or a no-op for memory |

`MemoryStore` is two `Map`s. Records are cloned on the way in and out. Saving an id that is already present replaces the value and does not move it in the map. `PostgresRunStore` uses the same pool settings as agents (at most 5 connections, 10 second connect timeout, TLS rules above).

A write that fails `validateRun` or `validateTrace` throws `ContractError` and stores nothing. The harness turns that into HTTP 500 on `POST /runs` and `POST /attacker/jury-case`, which is the same status the in-memory store already produced. `GET` of a missing id is still 404 `{ "error": "not_found", "message": "No run …" }` or `"No trace …"`.

There is no delete of one run or one trace, and no foreign key. Deleting an agent does not delete runs or traces that name it. Saving a trace does not require the run row to exist. That matches the memory maps. `deleteAllRunsAndTraces()` clears both tables together and is only used by backup reset.

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

`document` is the Trace object `GET /traces` returns. `run_id`, `agent_id`, and `started_at` are copied from that document. `started_at` is the attempt's own clock (a required Trace field). `created_at` is the first insert and is not a Trace field. A later save refreshes `started_at` from the new document and keeps `created_at`. Optional `Trace.source` lives inside `document`. It is not a column.

### OTel pull cursors

File: `apps/backend/migrations/004_otel_pull_cursors.sql`.

```sql
CREATE TABLE IF NOT EXISTS otel_pull_cursors (
  agent_id text NOT NULL,
  source text NOT NULL,
  last_pull_at timestamptz NOT NULL,
  PRIMARY KEY (agent_id, source),
  CONSTRAINT otel_pull_cursors_source_check CHECK (source IN ('prod', 'test'))
);
```

`last_pull_at` is the server time of the last successful `POST /agents/:agentId/traces/pull` for that source. It is not a Trace field and not an Agent field. There is no foreign key. `deleteAllRunsAndTraces` (used by `db:reset`) deletes these rows so the next pull omits `since` and reads the endpoint buffer again. The memory store drops the same map. See [otel.md](otel.md#pull-traces).

`traces_run_id_created_at_idx` serves `listTracesByRun` (`WHERE run_id = ? ORDER BY created_at, trace_id`). `traces_created_at_trace_id_idx` serves `GET /traces`. `GET /traces/:traceId` uses the primary key.

Neither table references `agents` or the other table. Runs are not stored inside `agents.document`.

## Migrations and bootstrap

Migrations run inside the backend process when it starts and `DATABASE_URL` is set. There is no separate migrate command. The memory store does not run SQL.

The runner is `applyMigrations` in `src/agents/postgres.ts`. `PostgresAgentStore.migrate()` and `PostgresRunStore.migrate()` both call it:

1. Creates `schema_migrations` if needed.
2. Reads `apps/backend/migrations/*.sql` in name order (`001_agents.sql`, `002_runs.sql`, `003_traces.sql`, `004_otel_pull_cursors.sql`). From the compiled image that directory is `/app/migrations` (the Dockerfile copies it next to `dist/`).
3. Skips a file whose name is already in `schema_migrations`.
4. Runs the file in a transaction, then records the file name. A UTF-8 BOM is stripped and CRLF is normalized to LF before the script runs, so a Windows checkout applies the same statements.

The statements also use `IF NOT EXISTS`, so applying a file by hand is safe. Starting the process twice does not insert a second copy of a seed row. It rewrites `reference-shop` or `external-library` when that document fails the Agent schema, its `updated_at` is earlier than that fixture, or the timestamp matches and the runtime or world URL differs. A newer valid row is kept. It does not duplicate run or trace rows. Missing demo run and trace ids are inserted once. A present id is left alone. `002_runs.sql`, `003_traces.sql`, and `004_otel_pull_cursors.sql` are applied on an empty database and skipped once their names are recorded.

Do not edit a file after it has been applied in a shared database. The runner will not apply it again. Add the next numbered file instead.

If Postgres is unreachable, startup throws and the process exits. The message says to check `DATABASE_URL`. It does not print the URL.

## Seed lifecycle

The fixtures are `packages/shared/examples/agent-reference-shop.json` (`reference-shop`) and `packages/shared/examples/agent-library-desk.json` (`external-library`). At seed time the backend writes this process's runtime and world URLs onto each copy. Each id is inserted, kept, or rewritten on its own. See [seed-endpoints.md](seed-endpoints.md).

| Event | Memory | Postgres |
| --- | --- | --- |
| Boot, id absent | Insert the fixture | `INSERT … ON CONFLICT DO NOTHING` |
| Boot, id present, document valid, `updated_at` newer than the fixture | Leave the row, including a `PUT` that renamed it or changed a URL | Same |
| Boot, document fails `validateAgent`, `updated_at` is earlier than the fixture, or `updated_at` matches the fixture and the runtime or world URL differs | Replace the row with the fixture for this process | `UPDATE` the row from the fixture |
| `DELETE /agents/reference-shop` or `DELETE /agents/external-library` | 409, row kept | 409, row kept |
| Process restart | New empty map, then seed agents and demo traces. Other agents, runs, and traces are gone | Rows stay. The agent seed is inserted or rewritten by the rules above. Missing demo run/trace ids are inserted. Other rows stay |
| `seedIfMissing()` again on a valid row newer than the fixture, or the same age with the same endpoints | No overwrite | No overwrite |

There is no `POST /internal/agents/reset` and no other HTTP wipe. The architect note on #50 marked that route optional, and that route is still absent. The backend has no auth, so a wipe route would be reachable by anyone who can call the process. Jury reset is the CLI in [Jury reset](#jury-reset). Demo runs and traces are seeded insert-if-missing (`seedDemoRunsAndTraces`): six OTel remaps plus the diagnosed T3 storyboard pair. A fresh memory process and a fresh Postgres database get the two agents plus those seven demo traces. Other runs and traces are not created.

A local wipe of the whole Postgres volume is still `docker compose down -v`, which deletes `mesa-pgdata`. The next start runs migrations on an empty database and seeds `reference-shop` and `external-library` because those ids are missing. `db:reset` does not delete the volume. It deletes runs, traces, and agents other than those seeds. A valid seed newer than its fixture is left as it is, including a name changed with PUT. An invalid or older seed is rewritten from its fixture. A row at the fixture timestamp is rewritten when its runtime or world URL differs from this process. Reset does not read a seed through `get`, so a document that fails the schema does not abort the command.

`deleteAllRowsForTests` exists on `PostgresAgentStore` (agents, including the seed) and on `PostgresRunStore` (traces, then runs) for the test suites. Neither is an HTTP route. The backup tests use schema `mesa_transfer_test` and do not write `public`.

## Retention

Nothing in this store expires. There is no TTL, no row cap, and no purge job.

| Event | Memory | Postgres |
| --- | --- | --- |
| Process restart | Other agents, runs, and traces are gone. The two demo agents and the demo traces are inserted again | Every run, trace, and agent row stays. Missing demo ids are inserted |
| `DELETE /agents/:id` (not the seed) | That agent row is gone. Runs and traces that name it stay | Same |
| Save the same `run_id` or `trace_id` again | Document replaced. List position unchanged | Document replaced. `created_at` unchanged, so list position stays |
| `docker compose down` | The process is gone | The `mesa-pgdata` volume keeps agents, runs, and traces |
| `docker compose down -v` | The process is gone | The volume is deleted. The next start migrates an empty database and seeds the two agents plus the demo traces |
| `db:reset -- --yes` | Not used. Stop the process instead. The next start has the two agents and the demo traces | Runs, traces, and agents other than `reference-shop` and `external-library` are deleted, then the demo traces are inserted again. A valid seed newer than its fixture stays. An invalid or older seed is rewritten. A same-age seed with different endpoints is rewritten. The volume stays |

There is no `DELETE /runs` or `DELETE /traces`. A jury reset that keeps the volume and the seed is [Jury reset](#jury-reset). A copy of the rows is [Backup and restore](#backup-and-restore).

`created_at` on `runs` and `traces` is an order column. It is not a retention clock. Rows are not deleted because they are old.

## API reference

No auth. Bodies are JSON. `Content-Type: application/json`.

`instance.base_url` in the examples is the agent runtime, not the shop. The laptop file shows port 3002 for `reference-shop`. The seeded row uses the URL for this process ([seed-endpoints.md](seed-endpoints.md)).

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

`GET /traces` is `{ "traces": [ ... ] }`, oldest first. One trace is the Trace document. Optional query: `agent_id`, `source` (`harness`, `demo_seed`, `otel_prod`, `otel_test`), `since`, and `until` (inclusive bounds on `started_at`). A bad value is HTTP 400. `GET /runs/:runId` is the Run document alone.

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

`POST /runs` and `POST /attacker/jury-case` still return the same bodies. They write through whichever store `DATABASE_URL` selected. `POST /diagnose` on the agent service is not this store. Grok still writes `diagnosis` only, and only on the trace it is given. When the backend resolved a task evalset it sends that object as prompt guidance; it is not persisted on the Trace. The harness does not call Grok.

### `GET /agents`

200. `{ "agents": [ ... ] }`, ordered by `created_at` then `agent_id`. After a fresh boot the list is the seed only.

```json
{
  "agents": [
    {
      "agent_id": "reference-shop",
      "name": "Reference shop assistant",
      "created_at": "2026-11-04T09:00:00.000Z",
      "updated_at": "2026-11-05T07:00:00.000Z"
    }
  ]
}
```

The real seed document also includes `description`, `instance`, `test_instance`, `traces`, `docs`, and `tasks`. The snippet above shows the identity fields. `GET /agents/reference-shop` returns the full fixture. `tasks[].evalset` and `otel` are optional user data on that document. The reference seed sets evalset on T1, omits it on T2–T5, and sets dual `otel.prod` / `otel.test` plus `otel_mock` (schema A). The library seed does the same with schema B. `POST /agents` and `PUT /agents/:agent_id` persist whatever the body carries, including a body that omits either field. The column is still `agents.document` jsonb. There is no evalset table. `POST /evalset/generate` proposes cases and does not write this row. The verifier does not read evalset and does not write `outcome.verifier` from it. `POST /agents/:agentId/otel/import` writes Trace rows and a baseline Run through the same run/trace store. It copies a supplied outcome and does not invent `fault.labels`. See [otel.md](otel.md).

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

`PUT /agents/reference-shop` is allowed. The next boot keeps that row when it still validates and its `updated_at` is greater than or equal to the fixture's `updated_at`. A stored seed that fails validation, or whose `updated_at` is earlier than the fixture, is rewritten from the fixture on boot.

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
  "message": "Agent reference-shop is a demo seed and cannot be deleted."
}
```

## Environment

| Variable | Who reads it | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | backend, at startup; `db:export`, `db:import`, `db:reset` | Postgres URL for agents, runs, and traces. Empty or unset means both stores stay in memory. Compose sets `postgres://mesa:mesa@mesa-postgres:5432/mesa`. Render sets it from `fromDatabase.connectionString`. Do not commit a real URL. Turbo passes this variable into `pnpm dev`. The CLI also reads `apps/backend/.env` when that file exists and this variable is blank in the shell. A non-blank shell value wins. The CLI never prints the URL |
| `TEST_DATABASE_URL` | `apps/backend` tests only | Disposable database for `test/agents-postgres.test.ts`, `test/runs-postgres.test.ts`, and `test/transfer-postgres.test.ts`. Unset skips those files. CI leaves it unset. The agent file uses schema `mesa_agent_test`. The run file uses `mesa_run_test`. The backup file uses `mesa_transfer_test`. None of them write `public.agents`, `public.runs`, or `public.traces`. A host containing `.render.com` is refused before connect. Turbo passes this variable into `pnpm test` |

There is no env var that turns on an HTTP wipe. Reset is the CLI, and it still requires `--yes`.

`apps/backend/.env.example` documents `DATABASE_URL` and leaves it commented out. Compose's `environment` block wins over a copied `.env`.

## Local runbook

### One mock writer

`POST /runs` and `POST /attacker/jury-case` share one lock inside the backend process that received them. The lock is taken before the shop reset and held until the snapshot, the verifier, and the save for that request are done. A second mutating request on that process receives HTTP 409:

```json
{
  "error": "world_busy",
  "message": "The mock world is busy with another run on this process. Retry after that run finishes. This is not a verifier failure."
}
```

That 409 means the mock world is busy. A failed task is HTTP 200 with `outcome.verifier.passed` false. `GET /agents`, `GET /runs`, and `GET /traces` answer while a run holds the gate. `GET /attacker/jury-case` still returns the case description. `POST /traces/:traceId/diagnose` does not take this lock.

Run one backend process against the demo shop. A second backend process can still reset that shop, and so can a client that calls the shop or `POST /internal/reset` directly. The lock stays inside one process. It leaves stored experiments in place. The shape of the gate is in [architecture.md](architecture.md#one-writer-for-the-mock-world).

### Without a database

From the repo root:

```bash
pnpm install
pnpm dev:backend
```

`GET http://127.0.0.1:3001/health` reports `agent_store` and `run_store` as `memory`. `GET /agents/reference-shop` returns the seed. `GET /traces` lists the seven demo traces. `GET /runs` is a snapshot of those demo runs until something else calls `POST /runs`. Other agents, and every non-demo run and trace, disappear when the process stops. The next start inserts the two agents and the demo traces again.

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

Agent, run, and trace rows live in the `mesa-pgdata` volume. `docker compose down` keeps the volume. `docker compose down -v` deletes it. The next `up` migrates and seeds `reference-shop` and `external-library` again, then inserts the demo traces if those ids are missing. `counts.agents` is 2. `GET /traces` is not empty. To drop non-seed agents and every run and trace without deleting the volume, use [Jury reset](#jury-reset) (it puts the demo traces back). To copy the rows first, use [Backup and restore](#backup-and-restore).

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

`test/transfer.test.ts` always runs. It covers the export file (a UTF-8 BOM and CR LF still parse; the writer emits LF only), an in-memory round trip, a second import that keeps `created_at`, a file that fails `validateTrace` and writes nothing, reset that keeps an edited seed, and HTTP export of a running process. `test/transfer-postgres.test.ts` is the gated file. It exports the SQL `created_at` column, imports that file, imports it again without moving `created_at`, and resets while keeping the seed. The schema is `mesa_transfer_test`.

## Render Postgres (`mesa-postgres`)

`render.yaml` defines one database in environment `demo` and wires `DATABASE_URL` on `mesa-backend` only. Yuri (diamanti-sg) owns Render workspace `tea-dblh716417fc738hr7vg` and applies the Blueprint. The dashboard steps are in [deploy.md](deploy.md#apply-the-database-yuri). Field names match the [Blueprint spec](https://render.com/docs/blueprint-spec). `mesa-frontend`, `mesa-agentservice`, and `mesa-mock-shop` are not given this variable. `FRONTEND_URL`, `AGENTSERVICE_URL`, `MOCK_SHOP_URL`, and env group `mesa-shared` stay as they are.

| Piece | Value | Why it is here |
| --- | --- | --- |
| Database name | `mesa-postgres` | Same environment as the demo web services (`mesa-agent-failure-lab` / `demo`). This is the Blueprint `name`. It is not the Compose container, and it is not renamed on later syncs |
| Plan | `free` (0.1 CPU / 256 MB) | Blueprint plan id `free`. Storage is the free plan's fixed 1 GB, so `diskSizeGB` is omitted. If the workspace rejects `free`, or the database must outlive the 30-day window, set `plan` to `0.1c-256mb` before syncing. The #72 note called that paid size `basic-256mb`. The spec's plan id for the same CPU and RAM, besides `free`, is `0.1c-256mb`. See [Render free Postgres limits](#render-free-postgres-limits) |
| Region | `frankfurt` | Same region as the web services. The internal URL works only when the service and the database share a region |
| `postgresMajorVersion` | `"16"` | Render fully supports 13 through 18. `16` matches Compose (`postgres:16-alpine`). Omitting the field would select the current default (18). This cannot be changed after create |
| `databaseName` / `user` | `mesa` / `mesa` | Render may suffix the database name. The connection string carries the real name. These cannot be changed after create |
| `DATABASE_URL` | `fromDatabase` / `connectionString` | The internal URL, format `postgresql://user:password@host:port/database`. Not the external URL. The password is not in git |
| `ipAllowList` | omitted | The default allows the external URL, which a laptop needs for `db:import`. `ipAllowList: []` would block that URL. Services in the same region can still use the internal URL either way |

`connectionString` is the private-network URL. It is not a public URL, and it is not in git. [Deploy for Free](https://render.com/docs/free) says a free web service can send private-network requests to data stores in the same region. It cannot receive private-network traffic. TLS is not required on that internal host, and the pool does not enable it for that URL. If a deploy shows that the free backend cannot open the host, the backend plan has to change. This file does not change the web service plan.

The external URL is for a laptop. It uses TLS (`sslmode=require` or a `.render.com` host). The pool turns those URLs into TLS with `rejectUnauthorized: false`. Do not put the external URL in `render.yaml`.

A Blueprint sync refreshes `DATABASE_URL` from the database. That sync runs on a push to `main` only when auto-sync is on for the Blueprint. Auto-sync off means the merge updates the file and does not create the database. Yuri then uses Manual Sync in the Dashboard. `autoDeployTrigger: commit` still redeploys `mesa-backend` on that push, which restarts the in-memory process. Export before that restart. `XAI_API_KEY` stays `sync: false`.

The same database holds agents, runs, and traces once `DATABASE_URL` is set and the backend has booted. Startup applies `001_agents.sql`, `002_runs.sql`, `003_traces.sql`, and `004_otel_pull_cursors.sql`, then seeds `reference-shop` and `external-library` when either id is missing.

## Backup and restore

Part of [#75](https://github.com/mesagroup/MESA-AgentFailureLab/issues/75) (epic [#64](https://github.com/mesagroup/MESA-AgentFailureLab/issues/64)). The scripts live in `apps/backend`:

| Script | What it does |
| --- | --- |
| `pnpm --filter @mesa/backend db:export -- --out <file>` | Read Postgres (`DATABASE_URL`) and write one JSON file. Applies pending migrations. Does not insert the demo seeds |
| `pnpm --filter @mesa/backend db:export -- --base-url <url> --out <file>` | Read a running backend over HTTP. Use this for an in-memory process. Do not set `DATABASE_URL` at the same time |
| `pnpm --filter @mesa/backend db:import -- --file <file>` | Validate every document, upsert into Postgres, then insert `reference-shop` and `external-library` if either id is missing. Rewrite a seed when the stored row fails validation or is older than its fixture |
| `pnpm --filter @mesa/backend db:reset -- --yes` | Delete runs, traces, and agents other than `reference-shop` and `external-library`. See [Jury reset](#jury-reset) |

The extra `--` is required so pnpm forwards the flags. A relative `--out` or `--file` is resolved from the directory where you started pnpm (`INIT_CWD`), which is the repo root in the examples below. The commands run with cwd `apps/backend`. They read `apps/backend/.env` when that file exists and `DATABASE_URL` is blank. A value already exported in the shell wins. The URL is not printed. The summary prints the host, port, and database name.

The file is UTF-8 JSON, LF newlines, no BOM. `format` is `mesa-persistence-v1`. Agents are Agent documents. Each run and each trace is `{ "created_at", "document" }` because that timestamp is not a field on the Run or Trace schema. `created_at_source` is `column` when the file was read from Postgres, and `order` when it was read from memory or HTTP. A second copy of the same id in one file is rejected. A document that fails `validateAgent`, `validateRun`, or `validateTrace` is rejected, and nothing is written.

Import is an upsert. A missing id is inserted with the `created_at` from the file. An id that is already stored keeps the `created_at` already in the database (the agent document field and the SQL column) and takes the rest of the document from the file, including `updated_at` on an agent. Importing the same file twice does not duplicate rows and does not move them. Rows that are not in the file are left in place. An empty file does not wipe the database. To make the file the whole database, run `db:reset -- --yes` and then import.

`db:export` against Postgres does not insert the seeds. A database that has never booted can export zero agents. `db:import` inserts each fixture afterwards when the file does not already contain that id. When the file does contain it, that document is upserted and the stored `created_at` stays. After that upsert, a stored seed that still fails validation or is older than its fixture is rewritten from the fixture. An invalid stored agent does not block the upsert: the file's document replaces that row.

### In-memory process

A new `db:export` process does not see rows that live in another process. With no `DATABASE_URL` and no `--base-url`, the command refuses to run. Those rows are already gone once that process stops. Export while it is still up:

```bash
pnpm --filter @mesa/backend db:export -- --base-url http://127.0.0.1:3001 --out mesa-backup.json
```

Windows PowerShell, from the repo root, with the backend already listening:

```powershell
pnpm --filter @mesa/backend db:export -- --base-url http://127.0.0.1:3001 --out mesa-backup.json
```

HTTP export calls `GET /health`, `GET /agents`, `GET /traces`, and `GET /runs`. `GET /runs` is newest first; the file stores oldest first, which is the store order. `GET /traces` is already oldest first. Every document is validated before the file is written.

That API does not return the SQL `created_at` column. The file uses order-preserving timestamps (`2000-01-01T00:00:00.000Z`, then one millisecond later, and so on) so a later import keeps list order. Those timestamps are the first-insert time once they land in Postgres. If `GET /health` already says `postgres`, export again with `DATABASE_URL` and without `--base-url` when you need the original column values. The command prints that on stderr.

There is no HTTP import. `POST /runs` starts a batch. It does not restore a saved Run. `POST /agents` cannot restore `created_at` the way the upsert does, and there is no route that writes a Trace document. Import always uses `DATABASE_URL`.

### Postgres file

From the repo root, with Compose Postgres published on `127.0.0.1:5432`:

```bash
export DATABASE_URL=postgres://mesa:mesa@127.0.0.1:5432/mesa
pnpm --filter @mesa/backend db:export -- --out mesa-backup.json
pnpm --filter @mesa/backend db:import -- --file mesa-backup.json
```

Windows PowerShell:

```powershell
$env:DATABASE_URL = "postgres://mesa:mesa@127.0.0.1:5432/mesa"
pnpm --filter @mesa/backend db:export -- --out mesa-backup.json
pnpm --filter @mesa/backend db:import -- --file mesa-backup.json
```

Do not commit the JSON file. It is a copy of the lab data. The local password `mesa` is the Compose default, not a production secret. A Render URL is a secret. Put it in the shell or in `apps/backend/.env` for the command, and do not commit that file either.

Passing both `DATABASE_URL` and `--base-url` is an error. Unset `DATABASE_URL` to read a running memory backend.

## Jury reset

`db:reset` deletes every run, every trace, and every agent whose id is not `reference-shop` or `external-library`. A valid seed newer than its fixture stays, including a name or other field changed with `PUT`. If an id is missing, that fixture is inserted. If the stored seed fails validation, is older than its fixture, or matches the fixture timestamp with different runtime or world URLs, it is rewritten. After the wipe, missing demo run and trace ids are inserted. Present ids are not overwritten. `DELETE` of either seed is still 409. Reset does not call that route.

To get the fixture body back after a valid edit, `PUT` the example document, or delete the volume with `docker compose down -v`. The next boot inserts the fixture because the row is gone. Reset is the step that keeps the volume. Boot already rewrites a seed that fails validation or is older than the fixture.

The command requires `--yes`. Without it, nothing is deleted. There is no HTTP route for this, and no env var that enables one. The backend has no auth. A route on port 3001 would let any caller wipe the jury database.

Export first if you might want the rows back.

Bash, from the repo root, against Compose Postgres:

```bash
export DATABASE_URL=postgres://mesa:mesa@127.0.0.1:5432/mesa
pnpm --filter @mesa/backend db:export -- --out jury-before-reset.json
pnpm --filter @mesa/backend db:reset -- --yes
curl -fsS http://127.0.0.1:3001/health
curl -fsS http://127.0.0.1:3001/agents
curl -fsS http://127.0.0.1:3001/runs
```

`GET /health` still reports `agent_store` and `run_store` as `postgres` when that URL is set on the running backend. `GET /agents` is the two demo seeds only. `GET /traces` lists the demo traces again. Operator runs that were not those seed ids are gone.

Windows PowerShell:

```powershell
$env:DATABASE_URL = "postgres://mesa:mesa@127.0.0.1:5432/mesa"
pnpm --filter @mesa/backend db:export -- --out jury-before-reset.json
pnpm --filter @mesa/backend db:reset -- --yes
Invoke-RestMethod http://127.0.0.1:3001/health | Select-Object status, agent_store, run_store
Invoke-RestMethod http://127.0.0.1:3001/agents
Invoke-RestMethod http://127.0.0.1:3001/runs
```

An in-memory backend has nothing for this command to delete. Stop that process. The next start has the two demo agents and the demo traces. `db:reset` without `DATABASE_URL` exits with that explanation and does not pretend to wipe the other process.

A URL whose host contains `.render.com` still runs when you pass `--yes`. The command prints the host (not the password) and tells you the hosted rows will be deleted. Export first. Render's free plan has no backups of its own. See [Render free Postgres limits](#render-free-postgres-limits).

## Cutover

The seed rules do not change in a cutover. On boot, `reference-shop` and `external-library` are inserted when that id is missing. A valid row newer than its fixture is not overwritten. An invalid or older row is rewritten from its fixture. A row at the fixture timestamp is rewritten when its endpoints differ. The origins are in [seed-endpoints.md](seed-endpoints.md). `DELETE` of either seed stays 409. Missing demo run and trace ids are inserted; present ids are kept. After `DATABASE_URL` is set, `GET /health` reports `agent_store` and `run_store` as `postgres`.

Memory rows exist only in the process that has them. Export before you stop it. A restart with no `DATABASE_URL` drops them. Setting `DATABASE_URL` on a new process does not copy them. The copy is the JSON file, then `db:import`.

### Local: memory process to Compose Postgres

1. Start the in-memory backend and use it until you want to keep the rows. `GET /health` shows `memory` for both stores.

```bash
pnpm dev:backend
curl -fsS http://127.0.0.1:3001/health
```

```powershell
pnpm dev:backend
Invoke-RestMethod http://127.0.0.1:3001/health | Select-Object agent_store, run_store
```

2. Export while that process is still running. Leave `DATABASE_URL` unset for this command.

```bash
pnpm --filter @mesa/backend db:export -- --base-url http://127.0.0.1:3001 --out mesa-backup.json
```

```powershell
pnpm --filter @mesa/backend db:export -- --base-url http://127.0.0.1:3001 --out mesa-backup.json
```

3. Stop the in-memory backend so port 3001 is free.

4. Start Compose. The backend waits for Postgres, migrates, and seeds `reference-shop` if that id is missing. `GET /health` on port 3001 now shows `postgres` for both stores.

```bash
docker compose up --build
curl -fsS http://127.0.0.1:3001/health
```

```powershell
docker compose up --build
Invoke-RestMethod http://127.0.0.1:3001/health | Select-Object agent_store, run_store
```

5. Import into the published database. The Compose backend reads the same database, so the next `GET` sees the rows. You do not restart it for the import to show up.

```bash
export DATABASE_URL=postgres://mesa:mesa@127.0.0.1:5432/mesa
pnpm --filter @mesa/backend db:import -- --file mesa-backup.json
curl -fsS http://127.0.0.1:3001/agents
curl -fsS http://127.0.0.1:3001/runs
curl -fsS http://127.0.0.1:3001/traces
```

```powershell
$env:DATABASE_URL = "postgres://mesa:mesa@127.0.0.1:5432/mesa"
pnpm --filter @mesa/backend db:import -- --file mesa-backup.json
Invoke-RestMethod http://127.0.0.1:3001/agents
Invoke-RestMethod http://127.0.0.1:3001/runs
Invoke-RestMethod http://127.0.0.1:3001/traces
```

`GET /runs` is the dashboard snapshot (newest start first). The SQL `created_at` from an HTTP export is the order-preserving timestamp, so the order matches the memory list. Agent `created_at` values come from the documents `GET /agents` returned.

To run Postgres only, and the backend on the host: `docker compose up -d mesa-postgres`, stop any backend already on 3001, then `pnpm dev:backend` with `DATABASE_URL=postgres://mesa:mesa@127.0.0.1:5432/mesa`. Check `/health`, then import the same way. Do not run the host backend and the Compose backend on port 3001 at the same time.

### Render: memory process to `mesa-postgres`

The hosted backend is in memory until `DATABASE_URL` is set. Those rows live only in that process. Export them before any redeploy. A push to `main` restarts `mesa-backend` because `autoDeployTrigger` is `commit`, even when the Blueprint does not sync. A Blueprint sync (auto-sync on that push, or Yuri's Manual Sync) sets `DATABASE_URL` from the internal `connectionString` and restarts the service onto Postgres. Either restart drops the in-memory agents, runs, and traces. The seed is inserted again on the new process. Nothing else is copied. The copy is the JSON file, then `db:import`.

Do the export while `GET /health` still says `memory`, and before the merge. Dashboard steps for the sync itself are in [deploy.md](deploy.md#apply-the-database-yuri).

1. Export the running memory process from a laptop. Leave `DATABASE_URL` unset for this command. The public URL is the one in [deploy.md](deploy.md).

```bash
pnpm --filter @mesa/backend db:export -- --base-url https://mesa-backend-itm4.onrender.com --out mesa-backup.json
```

```powershell
pnpm --filter @mesa/backend db:export -- --base-url https://mesa-backend-itm4.onrender.com --out mesa-backup.json
Invoke-RestMethod https://mesa-backend-itm4.onrender.com/health | Select-Object status, agent_store, run_store
```

Both stores should be `memory` on that check. If they are already `postgres`, this file is an HTTP export of Postgres and the SQL `created_at` column is not in it. Export again with the external URL and without `--base-url` when you need that column. If the process was already restarted while still on memory, the rows are gone. The file only contains what `GET /agents`, `GET /runs`, and `GET /traces` return at this moment. The seed is included. Runs are included only if they are still in that process. Keep the file. Do not commit it.

2. Merge, or have Yuri sync the Blueprint. Merging triggers a Blueprint sync only when auto-sync is on. Auto-sync off leaves `DATABASE_URL` unset until Manual Sync. The merge still redeploys the web service. After the sync, Render sets `DATABASE_URL` from `fromDatabase.connectionString` and redeploys `mesa-backend` onto Postgres. The free web service can send private-network requests to a database in the same region. The first request after idle can take about a minute while the free web service wakes.

3. Confirm the stores. Both `agent_store` and `run_store` must be `postgres` before you import. If either is `memory`, `DATABASE_URL` is not set. Do not import yet.

```bash
curl -fsS https://mesa-backend-itm4.onrender.com/health
```

```powershell
Invoke-RestMethod https://mesa-backend-itm4.onrender.com/health | Select-Object status, agent_store, run_store
```

4. Import from a laptop. The private `connectionString` is not reachable from your machine. In the Render Dashboard, open `mesa-postgres` and copy the **external** connection string. It is a secret. It uses TLS (`sslmode=require` or a `.render.com` host). The pool already turns those URLs into TLS with `rejectUnauthorized: false`. Do not commit the URL. Do not put it in `render.yaml`.

```bash
export DATABASE_URL='postgresql://USER:PASSWORD@HOST.render.com:5432/DATABASE?sslmode=require'
pnpm --filter @mesa/backend db:import -- --file mesa-backup.json
```

```powershell
$env:DATABASE_URL = "postgresql://USER:PASSWORD@HOST.render.com:5432/DATABASE?sslmode=require"
pnpm --filter @mesa/backend db:import -- --file mesa-backup.json
```

The command prints the host and database name, not the user or password. A `.render.com` host also prints a warning to export a copy first.

5. Read the public API again. `GET /health` stays `postgres`. `GET /agents/reference-shop` returns that seed (the imported document when the file had one). `GET /agents/external-library` returns the other. `GET /runs` lists the imported runs. `counts.agents` is at least 2.

```powershell
Invoke-RestMethod https://mesa-backend-itm4.onrender.com/health | Select-Object status, agent_store, run_store
Invoke-RestMethod https://mesa-backend-itm4.onrender.com/agents/reference-shop
Invoke-RestMethod https://mesa-backend-itm4.onrender.com/runs
```

Free web services have no shell, so these commands stay on your laptop. They are not run inside the Render container. A later redeploy keeps the Postgres rows. It does not keep a memory process's rows.

## Rollback

Keep the JSON file from before the cutover. It is the copy you can import again.

**Bad import.** Import upserts. It does not delete rows that are missing from the file. Import the previous file to put those documents back. `created_at` stays at whatever the database already stored for that id, so list order does not jump. Rows that exist only because of the bad import are still there. To drop them, `db:reset -- --yes` and then import the good file. Reset removes non-seed agents and every run and trace. The following import writes the good file. The seed row is kept; its document is updated from the file when the file contains `reference-shop`.

**Process back to memory.** Unset `DATABASE_URL` and start the backend again. `GET /health` shows `memory` for both stores. That process has the seed and no runs. The Postgres rows are still in the database or the `mesa-pgdata` volume. They are not visible until you point a process at that URL again. You do not need to import a second time if the database is still there. There is no way to push the JSON file into a memory process over HTTP.

Bash:

```bash
unset DATABASE_URL
pnpm dev:backend
curl -fsS http://127.0.0.1:3001/health
```

PowerShell:

```powershell
Remove-Item Env:DATABASE_URL
pnpm dev:backend
Invoke-RestMethod http://127.0.0.1:3001/health | Select-Object agent_store, run_store
```

**Volume gone.** `docker compose down -v` deletes `mesa-pgdata`. The next `docker compose up` migrates an empty database and seeds `reference-shop`. Import `mesa-backup.json` if you still want the exported rows.

**Render.** To run the hosted backend in memory again, remove `DATABASE_URL` from `mesa-backend` in the Dashboard and redeploy that service. `GET /health` then shows `memory` for both stores. The new process has the seed and no runs. The Postgres rows stay in `mesa-postgres` until the database is deleted or the free plan expires. Export before you drop it.

```powershell
Invoke-RestMethod https://mesa-backend-itm4.onrender.com/health | Select-Object status, agent_store, run_store
```

The next Blueprint sync puts `DATABASE_URL` back, because `render.yaml` declares `fromDatabase`. A one-off Dashboard delete does not survive that sync. To stay on memory across syncs, remove the `DATABASE_URL` entry from `mesa-backend` in `render.yaml` and sync again. Putting the variable back is the reverse: restore that entry, or set it again in the Dashboard until the next sync.

## Render free Postgres limits

Source: [Deploy for Free](https://render.com/docs/free). These limits are why the JSON export exists. Render's free Postgres does not keep a backup you can restore.

| Limit | What Render does | What you do |
| --- | --- | --- |
| 30-day expiry | A free database expires 30 days after creation and becomes inaccessible unless you upgrade it to a paid plan | The clock starts when Render creates the instance, not when the Blueprint merges. Set a reminder for that date and run `db:export` before it. Render also emails as the date gets close. The seed is recreated on a new database. Agents other than the seed, and every run and trace, are only in the JSON file |
| 14-day grace | After expiry you have 14 days to upgrade. Then Render deletes the database and all of its data | The JSON file is the copy that survives that delete. Create a new database (or upgrade in time) and `db:import` |
| No backups | Free Render Postgres does not support any form of backups | `db:export` is the backup. Keep the file off Render (your laptop, or other storage you control). Do not commit it |
| 1 GB | Free Postgres storage is fixed at 1 GB | This lab's agent, run, and trace documents are small. Export still works as a copy if you approach the cap. It does not raise the cap |
| One free database | A workspace can have one active free Postgres | `mesa-postgres` is that database. A second free instance is not available |
| Restarts and maintenance | Render may restart the database or run maintenance at any time. It is briefly unavailable | Rows are not documented as wiped on restart. The expiry delete is the wipe. Export anyway, because there is no Render backup to fall back on |

Free Key Value is a different product. Its data is lost on restart. This lab does not use it. Agents, runs, and traces are Postgres rows.

The export does not stop the 30-day clock and it does not upgrade the plan. It is the file you still have after Render deletes the database. Upgrade to a paid plan (Blueprint plan id `0.1c-256mb` for the same 0.1 CPU / 256 MB size), or create a new database and import, before the grace period ends if the demo still needs those rows. Smontuor's note on [#72](https://github.com/mesagroup/MESA-AgentFailureLab/issues/72) was to create the free database close to the demo, because the seed inserts itself, and to move to that paid size if the lab has to last longer than 30 days. Export before the expiry either way. Free Postgres has no backups of its own.

Not in this work: auth, multi-tenant isolation, a dedicated store service, edits to the JSON Schemas, or moving agent execution into the backend. The shop catalog is still in memory. `POST /internal/reset` on the shop is unchanged. `POST /diagnose` is still the agent service, and it still does not write `outcome.verifier` or `fault.labels`.
