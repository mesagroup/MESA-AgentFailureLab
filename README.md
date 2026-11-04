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
| [`services/mock-shop`](services/mock-shop/README.md) | Backend | Stand-alone external HTTP shop on port 8787. Catalog, cart, checkout, cancel, `GET /internal/state`. The harness calls `MOCK_SHOP_URL`. Own process, separate from the harness. |
| [`apps/agentservice`](apps/agentservice/README.md) | AI Engineer | Proposes T1–T5 actions (`executed: false`). Grok diagnosis writes `diagnosis` only. |
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

Hand-written T2, T3, and T5 traces are in `packages/shared/examples` and use the injector catalog codes. The reference agent is `POST /v1/tasks/run` on port 3002. The harness owns tool execution and `outcome.verifier`.
