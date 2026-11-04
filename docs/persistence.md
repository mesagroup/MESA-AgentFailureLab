# Agent persistence

Agent registration records live in the backend process (`apps/backend`). The store is a module in that process. It is not a separate service, and it is not part of the agent service or the mock shop.

This is the first slice of epic [#64](https://github.com/mesagroup/MESA-AgentFailureLab/issues/64). It closes the Agent CRUD in [#50](https://github.com/mesagroup/MESA-AgentFailureLab/issues/50). Runs and traces stay in memory. That work is [PR 2](#out-of-scope--pr-2-runtrace).

`packages/shared/schemas/agent.schema.json` is the document. Every create and replace calls `validateAgent` from `@mesa/shared/validate`. This change does not edit the schema.

## Why Postgres, and why memory remains

Agents have to survive a process restart and a redeploy. The lab's hosted target is Postgres on Render, selected with `DATABASE_URL`. The backend talks to it with `pg` (node-postgres). There is no Prisma and no second service.

The Agent document is a JSON Schema with nested tasks, docs, and instance URLs. The store keeps that document as one `jsonb` value. The schema file stays the contract. SQL does not restate each field.

CI and a laptop without a database still have to run `pnpm build` and `pnpm test`. The same `AgentStore` interface has an in-memory implementation. `DATABASE_URL` empty means that implementation. `GET /health` then reports `agent_store: "memory"`. A restart drops those rows and seeds `reference-shop` again.

`instance.base_url` and `test_instance.base_url` are the agent runtime (port 3002 for the reference agent). They are not the mock shop.

The harness runner still loads `packages/shared/examples/agent-reference-stub.json` through `loadReferenceAgent()` when it executes tasks. The CRUD store does not choose which agent a run uses.

## Architecture

```text
openAgentStore(env)
  DATABASE_URL blank  -> MemoryAgentStore
  DATABASE_URL set    -> PostgresAgentStore
                         migrate() then seedIfMissing()
buildApp({ agents })  -> registerAgentRoutes
```

`src/agents/store.ts` defines the interface. Both implementations honor it.

| Method | Behavior |
| --- | --- |
| `list()` | Agents ordered by `created_at`, then `agent_id` |
| `get(agentId)` | One agent, or absent |
| `create(body)` | Fill missing server fields, `validateAgent`, insert. Conflict if the id exists |
| `replace(agentId, body)` | 404 if absent. Server sets `updated_at`. Validate, then replace the document |
| `delete(agentId)` | 409 for `reference-shop`. 404 if another id is absent |
| `seedIfMissing()` | Insert the reference fixture only when `reference-shop` is absent |
| `close()` | End the pool, or a no-op for memory |

`src/agents/open.ts` reads `DATABASE_URL`. A blank or missing value returns `MemoryAgentStore`, which seeds in its constructor. A URL returns `PostgresAgentStore`, applies migrations, then seeds. `src/index.ts` does that before `listen`, and closes the store when the process closes the Fastify app.

`MemoryAgentStore` is a `Map`. Records are cloned on the way in and out. `PostgresAgentStore` uses a pool of at most 5 connections and a 10 second connect timeout. A URL with `sslmode=require`, or a host ending in `.render.com`, uses TLS with `rejectUnauthorized: false` (Render's public certificate). Compose and other local URLs stay non-TLS.

Writes that fail `validateAgent` throw `AgentValidationError` (HTTP 400). A duplicate id throws `AgentConflictError` (HTTP 409). A missing id throws `AgentNotFoundError` (HTTP 404). Deleting `reference-shop` throws `ProtectedAgentError` (HTTP 409).

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

Runs and traces do not have tables yet. Later files in the same directory own them (`002_….sql`, `003_….sql`). Do not store them in `agents`.

## Migrations and bootstrap

Migrations run inside the backend process when it starts and `DATABASE_URL` is set. There is no separate migrate command. The memory store does not run SQL.

The runner in `src/agents/postgres.ts`:

1. Creates `schema_migrations` if needed.
2. Reads `apps/backend/migrations/*.sql` in name order. From the compiled image that directory is `/app/migrations` (the Dockerfile copies it next to `dist/`).
3. Skips a file whose name is already in `schema_migrations`.
4. Runs the file in a transaction, then records the file name.

The statements also use `IF NOT EXISTS`, so applying `001_agents.sql` by hand is safe. Starting the process twice does not insert a second seed row and does not rewrite an existing agent.

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

There is no `POST /internal/agents/reset`. The architect note on #50 marked that route optional, and this PR does not add it.

A local wipe of Postgres data is `docker compose down -v`, which deletes the `mesa-pgdata` volume. The next start runs migrations on an empty database and seeds `reference-shop` because that id is missing.

`deleteAllRowsForTests` exists on `PostgresAgentStore` for the test suite. It is not an HTTP route.

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
  "agent_store": "memory"
}
```

`agent_store` is `"postgres"` when `DATABASE_URL` is set.

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
| `DATABASE_URL` | backend, at startup | Postgres URL. Empty or unset means in-memory. Compose sets `postgres://mesa:mesa@mesa-postgres:5432/mesa`. Render sets it from `fromDatabase.connectionString`. Do not commit a real URL. Turbo passes this variable into `pnpm dev` |
| `TEST_DATABASE_URL` | `apps/backend` tests only | Disposable database for `test/agents-postgres.test.ts`. Unset skips those tests. CI leaves it unset. The suite creates schema `mesa_agent_test` and deletes rows there. It does not write `public.agents`. A host containing `.render.com` is refused. Turbo passes this variable into `pnpm test` |

`apps/backend/.env.example` documents `DATABASE_URL` and leaves it commented out. Compose's `environment` block wins over a copied `.env`.

## Local runbook

### Without a database

From the repo root:

```bash
pnpm install
pnpm dev:backend
```

`GET http://127.0.0.1:3001/health` reports `agent_store` `memory`. `GET /agents/reference-shop` returns the seed. Other agents disappear when the process stops.

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

`GET /health` on the backend reports `agent_store` `postgres`.

Agent rows live in the `mesa-pgdata` volume. `docker compose down` keeps the volume. `docker compose down -v` deletes it. The next `up` migrates and seeds `reference-shop` again.

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

The backend image also boots with no `DATABASE_URL` (CI's `docker run` health check). It uses the memory store and answers `GET /health`.

## Postgres-only tests

`apps/backend/test/agents-postgres.test.ts` exercises `PostgresAgentStore`: migrate twice, create, conflict, protected delete, a second pool that still sees the row, and the HTTP routes on that store.

The file skips the suite when `TEST_DATABASE_URL` is unset, which is the CI default. `pnpm test` then still passes. Set the variable to a disposable local database to run the suite. It creates schema `mesa_agent_test`, deletes rows in that schema, and does not touch `public.agents`.

```bash
export TEST_DATABASE_URL=postgres://mesa:mesa@127.0.0.1:5432/mesa
pnpm --filter @mesa/backend test
```

Windows PowerShell:

```powershell
$env:TEST_DATABASE_URL = "postgres://mesa:mesa@127.0.0.1:5432/mesa"
pnpm --filter @mesa/backend test
```

Root `pnpm test` forwards `TEST_DATABASE_URL` (see `turbo.json`). Do not point it at Render.

In-memory CRUD coverage is `apps/backend/test/agents.test.ts`. That file always runs.

The Postgres tests use the same `pg` driver as production, against a real server, instead of an embedded engine. They stay out of CI so `pnpm test` does not need a database. They were run locally against Postgres 16.

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

Runs and traces are not in this database.

## Out of scope / PR 2 (Run/Trace)

This PR does not persist Runs or Traces. `src/persistence/memory.ts` is still the Run and Trace store. Restart still drops them. The shop catalog is still in memory. `POST /internal/reset` on the shop is unchanged.

PR 2 should:

- Add `apps/backend/migrations/002_….sql` and `003_….sql` for Run and Trace. Leave `001_agents.sql` unchanged. The existing runner will apply new files once, in order.
- Keep JSON Schema (`validateRun`, `validateTrace`) as the document check, the same way `validateAgent` guards this table.
- Keep an in-memory implementation behind the same store interface so CI still runs without `DATABASE_URL`.
- Leave agent CRUD and the `reference-shop` seed behavior as they are here.

Not in either PR: auth, multi-tenant isolation, a dedicated store service, schema changes, or moving agent execution into the backend.
