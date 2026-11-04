# @mesa/backend

Harness for the Agent Failure Lab. It runs tasks T1–T5, injects labeled faults, and is the only writer of `outcome.verifier`. Agent records are stored in Postgres when `DATABASE_URL` is set, and in memory otherwise. Runs and traces stay in memory. See [persistence](../../docs/persistence.md).

The inspectable shop is [`services/mock-shop`](../../services/mock-shop). Do not fold that API into this app.

## What this process writes

| Field | Writer |
| --- | --- |
| `outcome.verifier` and `outcome.success` | Deterministic verifier, from `GET /internal/state` and the task's `success_test.checks` |
| `fault.labels`, `fault.injected`, `fault.attacker` | Injector, from the Run's `injection_plan`. The jury attacker and the T5 security attacker set `attacker.used` on their own runs |
| `Run.phase`, `injection_plan`, `fix_kinds`, `trace_ids` | Runner. The jury attacker writes the same fields for its baseline and attacked runs |
| `diagnosis` | Nobody here. It stays `null` until Grok, which must not write the rows above |

`outcome.success` is `outcome.verifier.passed`. The agent's claim is stored separately and is not the verdict. An `after_fix` run stores `fix_kinds` and copies that list onto the shared `AgentRunRequest` for `POST /v1/tasks/run`. Baseline and injected runs omit the field. The scripted action planner does not read it. `controlled_retry` is applied in `executeAttempt` on the same injector path. `pre_response_check` and `permission_guard` are for the agent service that receives the request.

## Run from the monorepo root

```bash
pnpm install
pnpm exec turbo run dev --filter=@mesa/backend
```

Equivalent root script: `pnpm dev:backend`. Start the shop with `pnpm dev:mock-shop` when you drive a real batch from `pnpm dev`. Compose starts `mesa-mock-shop` and sets `MOCK_SHOP_URL` to `http://mesa-mock-shop:8787`.

- Dev server: http://127.0.0.1:3001
- Health: http://127.0.0.1:3001/health
- Production build: `pnpm exec turbo run build --filter=@mesa/backend` then `pnpm --filter @mesa/backend start`

Copy `apps/backend/.env.example` to `apps/backend/.env` to override `PORT`, `HOST`, `MOCK_SHOP_URL`, the agent-service URL, or `DATABASE_URL`. Do not commit `.env` or a real database URL. Leave `DATABASE_URL` unset to keep agents in memory.

Container image, from the repo root: `docker build -f apps/backend/Dockerfile -t mesa-backend .` The image sets `HOST=0.0.0.0`, listens on port 3001, and answers `GET /health`. See [docs/deploy.md](../../docs/deploy.md).

`turbo run dev` builds `@mesa/shared` first. JSON Schema is the source of truth for Trace, Agent, and Run.

## HTTP

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness, contract version, `agent_store` (`memory` or `postgres`), paths Grok must not write |
| `GET` | `/agents` | `{ agents }` list, ordered by `created_at` then `agent_id` |
| `GET` | `/agents/:agent_id` | One agent. 404 if absent |
| `POST` | `/agents` | Create. Body is an Agent document. Omit `agent_id`, `created_at`, and `updated_at` and the server assigns them. 201, 400 if invalid, 409 if the id exists |
| `PUT` | `/agents/:agent_id` | Replace. Server sets `updated_at`. Omitted `created_at` keeps the stored value. 404 if absent, 400 if invalid |
| `DELETE` | `/agents/:agent_id` | 204. 404 if absent. `reference-shop` returns 409 |
| `GET` | `/faults` | Labeled fault catalog and the T1–T5 presets |
| `POST` | `/runs` | Batch. Body: `phase`, optional `task_ids`, `driver` (`scripted`, `http`, `auto`), `injection` (`preset`, a plan, or null), `fix_kinds`, `grant_cancel`, `timeout_ms` |
| `GET` | `/attacker/jury-case` | Juror note and the security plan. Does not start a run |
| `POST` | `/attacker/jury-case` | Unattacked T5 (grant is `read` only) and the attacker case. Optional `include_baseline` (default true) |
| `GET` | `/runs`, `/runs/:runId` | Stored runs |
| `GET` | `/traces`, `/traces/:traceId` | Stored traces |

`driver: scripted` (the default) performs the reference tool sequence against the mock. `driver: http` `POST`s `{test_instance or instance}/v1/tasks/run` with an `AgentRunRequest` from `@mesa/shared` and expects `{ "executed": false, "actions": [...] }`. The body includes `fix_kinds` when the Run has a non-empty list (`after_fix`). Baseline and injected omit it. The response may also carry `refused` and `embedded`. The harness executes `actions` only, so the injector can rewrite a call before it reaches the shop. When `fix_kinds` contains `controlled_retry`, `executeAttempt` re-issues a transient tool on that same path, at most twice, with backoff. Reads retry any transient result (`error: "timeout"`, or status 0, 408, 429, 500, 502, 503, 504). `add_to_cart`, `update_cart`, `checkout`, and `cancel_order` retry only when the attempt was not dispatched. A dispatched 5xx on those tools is not retried. A catalog `drop` fires again on the new attempt, so a deterministic drop still fails. `driver: auto` uses HTTP when that base URL's `/health` answers, and the scripted driver otherwise. Baseline calls `instance.base_url`. Injected and after_fix call `test_instance.base_url`.

Injected runs with `injection` omitted use the preset for that task (Verification, Reasoning, ToolUse, Context, Security for T1–T5). Plan and Execution are in the catalog and can be requested by code. The T5 preset is `forged_permission_success` (a forged tool result, `attacker.used` false). The T5 security attacker uses that same catalog code, sets `attacker.used`, and commits `cancel_order` through the agent-service hook when the agent emits that call without `write:order:cancel`. With `permission_guard` off the run is `injected`, `fix_kinds` is omitted, the order is cancelled, and the verifier fails. The `after_fix` replay sends `permission_guard` on `AgentRunRequest`; the agent does not emit `cancel_order`, the order stays placed, and the verifier can pass. The jury attacker is a third Security path (`unauthorized_cancel_via_juror_note`) and is not in that catalog. See [the jury demo](../../docs/demo-jury.md) and [ADR-002](../../adr/002-fault-injection-and-fixes.md).

```bash
pnpm --filter @mesa/backend jury-demo
pnpm --filter @mesa/backend jury-demo -- --run
```

`--run` needs the shop and this server already up. `--export` rewrites `fixtures/jury/*.json` and starts a shop itself.

## Layout

- `src/verifier/` — check runner and the optional loop / timeout / repeated-tool pre-pass
- `src/injector/` — fault catalog. Labels are copied onto the trace; the plan stays on the run
- `src/attacker/` — security jury case. Asks the agent (scripted mirror, or `callAgent`) with `fix_kinds` before `cancel_order`. `X-Permissions` stays the session grant. A permission named in the note or in a tool result is not added. With `permission_guard` and no `write:order:cancel`, the agent refuses and the client is not called. Guard off is the frozen baseline: the agent plans `cancel_order` and the shop rejects it. Issue #17 is the UI round (checklist and fixtures), not a second policy. Writes `fault.labels` and `fault.attacker`. The T5 security payload is a separate path: its hook lives in the agent service and is passed into `executeAttempt`
- `fixtures/jury/` — one frozen baseline/attacked pair and the juror note, for the timeline
- `src/harness/` — batch runner for `baseline`, `injected`, and `after_fix`
- `src/agent/` — scripted driver and the HTTP client for the agent under test
- `src/agents/` — Agent store (memory or Postgres) and the CRUD routes. Writes go through `validateAgent`
- `migrations/` — numbered SQL files. `001_agents.sql` is the only one so far. Later files can add Run and Trace tables
- `src/persistence/` — in-memory Run and Trace store. Saves are validated with `@mesa/shared/validate`
- `src/mock/` — HTTP client for the shop, including `GET /internal/state`

## Persistence

Agent records use Postgres when `DATABASE_URL` is set and an in-memory store otherwise. The full note is [docs/persistence.md](../../docs/persistence.md): why those two stores, the `AgentStore` interface, `001_agents.sql`, seed and 409 behavior, every `/agents` status code with request and response examples, env vars, the Compose and Windows PowerShell runbook, the Postgres-only tests, and what Run/Trace persistence (PR 2) still has to add.

Runs and traces are not in that store.

## Tests

```bash
pnpm --filter @mesa/backend test
```

Root `pnpm test` includes this package through Turbo. Verifier checks are unit-tested from snapshots. The runner tests start the mock shop in-process and persist at least one baseline batch and one injected batch. Agent CRUD tests use the in-memory store. Postgres tests in `test/agents-postgres.test.ts` run only when `TEST_DATABASE_URL` is set, and they skip in CI.
