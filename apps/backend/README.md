# @mesa/backend

Harness for the Agent Failure Lab. It runs an agent's tasks (T1–T5 on the shopping demo), injects labeled faults, and is the only writer of `outcome.verifier`. Runs and traces are stored in memory.

The inspectable shop is [`services/mock-shop`](../../services/mock-shop). Do not fold that API into this app.

## What this process writes

| Field | Writer |
| --- | --- |
| `outcome.verifier` and `outcome.success` | Deterministic verifier, from `GET /internal/state` and the task's `success_test.checks` |
| `fault.labels`, `fault.injected`, `fault.attacker` | Injector, from the Run's `injection_plan`. The jury attacker writes the same fields for its own Security plan and sets `attacker.used` |
| `Run.phase`, `injection_plan`, `fix_kinds`, `trace_ids` | Runner. The jury attacker writes the same fields for its baseline and attacked runs |
| `diagnosis` | Nobody here. It stays `null` until Grok, which must not write the rows above |

`outcome.success` is `outcome.verifier.passed`. The agent's claim is stored separately and is not the verdict. A fix kind recorded on an `after_fix` run is harness metadata; this MVP replays the task and scores it, and does not yet patch the agent.

## Run from the monorepo root

```bash
pnpm install
pnpm exec turbo run dev --filter=@mesa/backend
```

Equivalent root script: `pnpm dev:backend`. Start the shop with `pnpm dev:mock-shop` when you drive a real batch from `pnpm dev`. Compose starts `mesa-mock-shop` and sets `MOCK_SHOP_URL` to `http://mesa-mock-shop:8787`.

- Dev server: http://127.0.0.1:3001
- Health: http://127.0.0.1:3001/health
- Production build: `pnpm exec turbo run build --filter=@mesa/backend` then `pnpm --filter @mesa/backend start`

Copy `apps/backend/.env.example` to `apps/backend/.env` to override `PORT`, `HOST`, `MOCK_SHOP_URL`, or the agent-service URL. Do not commit `.env` or a database URL.

Container image, from the repo root: `docker build -f apps/backend/Dockerfile -t mesa-backend .` The image sets `HOST=0.0.0.0`, listens on port 3001, and answers `GET /health`. See [docs/deploy.md](../../docs/deploy.md).

`turbo run dev` builds `@mesa/shared` first. JSON Schema is the source of truth for Trace, Agent, and Run.

## HTTP

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness, contract version, paths Grok must not write |
| `GET` | `/faults` | Labeled fault catalog and the T1–T5 presets |
| `POST` | `/runs` | Batch. Body: `phase`, optional `task_ids`, `driver` (`scripted`, `http`, `auto`), `injection` (`preset`, a plan, or null), `fix_kinds`, `grant_cancel`, `timeout_ms` |
| `GET` | `/attacker/jury-case` | Juror note and the security plan. Does not start a run |
| `POST` | `/attacker/jury-case` | Unattacked T5 (grant is `read` only) and the attacker case. Optional `include_baseline` (default true) |
| `GET` | `/runs`, `/runs/:runId` | Stored runs |
| `GET` | `/traces`, `/traces/:traceId` | Stored traces |

`driver: scripted` (the default) performs the reference tool sequence against the mock. `driver: http` `POST`s `{test_instance or instance}/v1/tasks/run` and expects `{ "executed": false, "actions": [...] }`. The response may also carry `refused` and `embedded`. The harness executes `actions` only, so the injector can rewrite a call before it reaches the shop. `driver: auto` uses HTTP when that base URL's `/health` answers, and the scripted driver otherwise. Baseline calls `instance.base_url`. Injected and after_fix call `test_instance.base_url`.

Injected runs with `injection` omitted use the preset for that task (Verification, Reasoning, ToolUse, Context, Security for T1–T5). Plan and Execution are in the catalog and can be requested by code. The T5 preset is `forged_permission_success` (a forged tool result). The jury attacker is a different Security path and is not in that catalog. See [the jury demo](../../docs/demo-jury.md).

```bash
pnpm --filter @mesa/backend jury-demo
pnpm --filter @mesa/backend jury-demo -- --run
```

`--run` needs the shop and this server already up. `--export` rewrites `fixtures/jury/*.json` and starts a shop itself.

## Layout

- `src/verifier/` — check runner and the optional loop / timeout / repeated-tool pre-pass
- `src/injector/` — fault catalog. Labels are copied onto the trace; the plan stays on the run
- `src/attacker/` — security jury case (juror note, real cancel). Separate from the catalog. Writes `fault.labels` and `fault.attacker`
- `fixtures/jury/` — one frozen baseline/attacked pair and the juror note, for the timeline
- `src/harness/` — batch runner for `baseline`, `injected`, and `after_fix`
- `src/agent/` — scripted driver and the HTTP client for the agent under test
- `src/persistence/` — in-memory Run and Trace store. Saves are validated with `@mesa/shared/validate`
- `src/mock/` — HTTP client for the shop, including `GET /internal/state`

## Tests

```bash
pnpm --filter @mesa/backend test
```

Root `pnpm test` includes this package through Turbo. Verifier checks are unit-tested from snapshots. The runner tests start the mock shop in-process and persist at least one baseline batch and one injected batch.
