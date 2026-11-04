# MESA Agent Failure Lab

Monorepo for Track 03 — Agent Failure Lab / CHAOS.AI. Frontend, Backend, and the AI Engineer each get an app. Contracts, product docs, and architecture decisions sit outside those apps.

The lab runs a shopping agent against a mock store, scores the task with a deterministic verifier, and uses Grok only to diagnose failures and propose fixes. A fix counts after the harness replays it and the verifier agrees. The shop is its own HTTP server. The harness and the agent service call it by URL. Details: [docs/overview.md](docs/overview.md), [docs/architecture.md](docs/architecture.md), and [ADR-001](adr/001-mock-verifier-grok.md).

## Monorepo map

```
/
  apps/
    frontend/        # web UI — registration, runs, timeline
    backend/         # harness, verifier, injector, persistence
    agentservice/    # Grok reference agent, diagnosis, fix proposals
  services/
    mock-shop/       # stand-alone HTTP shop; external target via URL, port 8787
  packages/
    shared/          # JSON Schema + TypeScript contracts (Trace, Agent, Run)
  docs/              # product and contributor docs (not ADRs)
  adr/               # Architecture Decision Records only
  package.json
  turbo.json
  pnpm-workspace.yaml
```

| Path | Team | Owns |
| --- | --- | --- |
| [`apps/frontend`](apps/frontend/README.md) | Frontend | Registration, runs, timeline. Renders `Trace`. Before/after uses `Run` + `outcome.verifier`. |
| [`apps/backend`](apps/backend/README.md) | Backend | Harness phases, deterministic verifier, labeled injector, security attacker, in-memory Run/Trace persistence. No auth. |
| [`services/mock-shop`](services/mock-shop/README.md) | Backend | Stand-alone external HTTP shop on port 8787. Catalog, cart, checkout, cancel, `GET /internal/state`. Harness calls `MOCK_SHOP_URL`. The agent service calls a configured tool base URL. Own process, separate from the harness. |
| [`apps/agentservice`](apps/agentservice/README.md) | AI Engineer | Reference agent and Grok diagnosis. Writes `diagnosis` only. |
| [`packages/shared`](packages/shared/README.md) | All | Shared contracts. JSON Schema is the source of truth for Trace, Agent, and Run. |
| [`docs/`](docs/README.md) | All | Overview, runtime architecture, and contributor guide. |
| [`adr/`](adr/README.md) | Architect | Numbered ADRs, separate from `docs/`. |

## Install and run

Requires Node.js 22.12+ and pnpm 10.33.4 (`packageManager` in `package.json`).

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

`pnpm build` runs `turbo run build` for `@mesa/shared`, the three apps, and `@mesa/mock-shop`.

Run the app you own:

```bash
pnpm exec turbo run dev --filter=@mesa/frontend      # http://127.0.0.1:3000
pnpm exec turbo run dev --filter=@mesa/backend       # http://127.0.0.1:3001  GET /health
pnpm exec turbo run dev --filter=@mesa/agentservice  # http://127.0.0.1:3002  GET /health
pnpm exec turbo run dev --filter=@mesa/mock-shop     # http://127.0.0.1:8787  GET /health
```

Shortcuts: `pnpm dev:frontend`, `pnpm dev:backend`, `pnpm dev:agentservice`, `pnpm dev:mock-shop`. `pnpm dev` starts every dev script.

## Classification eval

`pnpm eval` scores the labelled set and writes `apps/agentservice/eval/results/latest.json` and `latest.md`. The rules baseline is the diagnosis pre-pass (`diagnosisFindings` in `apps/agentservice`), mapped to one category and one step, with no model call. ADR-002 keeps that pre-pass distinct from `apps/backend/src/verifier/prepass.ts`, so the runner sits next to `diagnoseTrace` and does not keep a second copy of the findings. Grok runs when `XAI_API_KEY` is set. With no key, that column is skipped. `pnpm eval -- --fake` is a labelled stand-in for tests and is not a Grok score.

The evaluator reads ground truth from the trace after the methods run. Category and step come from the single `fault.labels` entry. When `fault.attacker.used` is true, the manifest source is `fault.attacker`: that object has no category, and ADR-002 says the attacker wrote the label. `diagnoseTrace` still drops `fault` before the model call.

The manifest is `apps/agentservice/eval/dataset/manifest.json`. It lists the shared T3 fixture, the jury attack fixture, and traces from `pnpm generate-dataset`. That script starts the mock shop on loopback and runs the merged scripted driver with catalog faults. It does not call the reference agent in open PR #21, so traces where the model itself picks the wrong tool are still absent.

Issue #16 also names a verified fix rate. ADR-001 defines that as a verifier delta after replay. The applicator is not on main, so the hit rate here is whether `proposed_fixes` contains the ADR-002 fix for the labelled category: `controlled_retry` for Execution, `pre_response_check` for Verification, `permission_guard` for Security. Plan, ToolUse, Context, and Reasoning have no MVP fix and stay out of that denominator.

PR #28 copies injector markers into steps the model sees: `Injected execution drop before the mock was called.`, `Injector skipped`, `Injector target … was not called.`, and the JSON booleans `forged: true`, `stale: true`, `injected: true` (`apps/backend/src/injector/catalog.ts`, `apps/backend/src/harness/execute.ts`). A model can read the marker and name the planted fault. The scoreboard counts traces that contain one. Follow-up for @diamanti-sg. This eval does not change `apps/backend`.

`timeout-repeated-tool-trace.json` and `tool-error-trace.json` stay out of the scored set. A clean trace cannot carry `fault.labels`.

<!-- eval-scoreboard:start -->
Definitions
- `category_accuracy`: Predicted category equals the single fault.labels category. Abstain and a failed diagnosis are misses. The denominator is every scored trace.
- `step_accuracy_exact`: Predicted step_id equals the labelled step_id.
- `step_accuracy_tolerance_1`: Absolute difference of step.index between the prediction and the labelled step is at most 1, including an exact match. A predicted step_id that is not on the trace is a miss.
- `proposed_fix_hit_rate`: The ADR-002 fix for the labelled category appears in proposed_fixes. Execution → controlled_retry, Verification → pre_response_check, Security → permission_guard. Plan, ToolUse, Context, and Reasoning have no MVP fix and are excluded. Extra proposed fixes do not cancel a hit. This is a proposal match, not a verifier replay.
- `mean_latency_ms`: Arithmetic mean of one pass over the scored traces. The timer wraps rulesBaseline or diagnoseTrace after the trace is already loaded. This is a description of that pass, not a tuned benchmark and not a median of repeated trials.
- `tokens_and_cost`: Input and output tokens and cost_usd are whatever the provider reported. Missing usage stays null. Token counts are not converted into a price. Failed diagnoses still add tokens when the provider returned usage before the response was rejected.

Rules baseline mapping. The first diagnosis finding in repair priority is the prediction. No finding abstains.
- false_success_claim → Verification / pre_response_check
- tool_error → Execution / controlled_retry
- repeated_tool_call → Reasoning / (none)
- timeout → Execution / controlled_retry

Scores
- Scored traces: 19
- Categories: 7 (Plan, ToolUse, Context, Reasoning, Execution, Verification, Security)
- Baseline category accuracy: 4/19
- Baseline step accuracy exact: 3/19
- Baseline step accuracy tolerance 1: 10/19
- Baseline proposed-fix hits: 4/7
- Baseline proposed-fix not applicable: 12
- Traces with injector hints: 13/19
- Grok: skipped (XAI_API_KEY is unset)

Timing (one pass; latency describes that pass and is not a tuned benchmark)
- Baseline mean latency ms: 0.033
- Baseline tokens in/out: n/a
- Baseline cost usd: n/a
<!-- eval-scoreboard:end -->

Per-trace rows and the confusion tables are in [apps/agentservice/eval/results/latest.md](apps/agentservice/eval/results/latest.md). `pnpm eval` rewrites the scoreboard above.

Copy an app's `.env.example` to `.env` only when you need overrides. Do not commit `.env` or a Grok API key. `XAI_API_KEY` in `apps/agentservice/.env.example` is an empty placeholder.

## Docker and Render

Three images, built from the repo root so `packages/shared` is in the context:

```bash
docker build -f apps/frontend/Dockerfile -t mesa-frontend .
docker build -f apps/backend/Dockerfile -t mesa-backend .
docker build -f apps/agentservice/Dockerfile -t mesa-agentservice .
docker compose up --build
```

| Image | Port | Health |
| --- | --- | --- |
| `mesa-frontend` | 3000 | `GET /health` |
| `mesa-backend` | 3001 | `GET /health` |
| `mesa-agentservice` | 3002 | `GET /health` |

Containers listen on `0.0.0.0`. `pnpm dev` still binds `127.0.0.1`. Compose publishes the ports above on a shared network (`mesa-frontend`, `mesa-backend`, `mesa-agentservice`). The Render Blueprint groups the same three free Frankfurt services in project `mesa-agent-failure-lab`, environment `demo`. The shop stays off that stack: run `@mesa/mock-shop` yourself on port 8787 and set `MOCK_SHOP_URL`. It is not a Blueprint service yet ([#21](https://github.com/mesagroup/MESA-AgentFailureLab/pull/21)). Env vars, `XAI_API_KEY`, and the Dashboard apply steps: [docs/deploy.md](docs/deploy.md).

## Docs

- [Overview](docs/overview.md) — product, track, boundaries
- [Architecture](docs/architecture.md) — stand-alone mock shop, ports, ADR-001 writers, Render
- [Getting started](docs/getting-started.md) — contributor workflow and stack choices
- [Jury demo](docs/demo-jury.md) — one security case, baseline comparison, limitations
- [Deploy](docs/deploy.md) — Docker, Compose, Render Blueprint, secrets
- [ADRs](adr/README.md) — decisions only; [ADR-001](adr/001-mock-verifier-grok.md) is the mock / verifier / Grok freeze

## Contracts

`packages/shared` exports the frozen shapes. `outcome.verifier` is the only pass/fail authority. `diagnosis` stays null until Grok writes it, and Grok must not write `outcome.verifier` or `fault.labels`.

- **Trace** — steps, per-step timings and costs, totals, `outcome.verifier`, fault labels, `diagnosis`
- **Agent** — instance, test instance, trace store, docs, tasks with `verifier_checks` (the reference stub has T1–T5)
- **Run** — harness metadata (`phase`, `injection_plan`, `fix_kinds`, `trace_ids`), not nested in Trace
