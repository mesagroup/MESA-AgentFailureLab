# MESA Agent Failure Lab

Monorepo for Track 03 — Agent Failure Lab / CHAOS.AI. Frontend, Backend, and the AI Engineer each get an app. Contracts, product docs, and architecture decisions sit outside those apps.

The lab runs a shopping agent against a mock store, scores the task with a deterministic verifier, and uses Grok only to diagnose failures and propose fixes. A fix counts after the harness replays it and the verifier agrees. Details: [docs/overview.md](docs/overview.md) and [ADR-001](adr/001-mock-verifier-grok.md).

## Monorepo map

```
/
  apps/
    frontend/        # web UI — registration, runs, timeline
    backend/         # mock e-commerce, verifier, harness, persistence
    agentservice/    # Grok reference agent, diagnosis, fix proposals
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
| [`apps/backend`](apps/backend/README.md) | Backend | Mock world state, deterministic verifier, harness phases, persistence. No auth. |
| [`apps/agentservice`](apps/agentservice/README.md) | AI Engineer | Reference agent and Grok diagnosis. Writes `diagnosis` only. |
| [`packages/shared`](packages/shared/README.md) | All | Shared contracts. JSON Schema is the source of truth for Trace and Agent. |
| [`docs/`](docs/README.md) | All | Overview and contributor guide. |
| [`adr/`](adr/README.md) | Architect | Numbered ADRs, separate from `docs/`. |

## Install and run

Requires Node.js 22.12+ and pnpm 10.33.4 (`packageManager` in `package.json`).

```bash
pnpm install
pnpm build
```

`pnpm build` runs `turbo run build` for the shared package and all three apps.

Run the app you own:

```bash
pnpm exec turbo run dev --filter=@mesa/frontend      # http://127.0.0.1:3000
pnpm exec turbo run dev --filter=@mesa/backend       # http://127.0.0.1:3001  GET /health
pnpm exec turbo run dev --filter=@mesa/agentservice  # http://127.0.0.1:3002  GET /health
```

Shortcuts: `pnpm dev:frontend`, `pnpm dev:backend`, `pnpm dev:agentservice`. `pnpm dev` starts every app.

Copy an app's `.env.example` to `.env` only when you need overrides. Do not commit `.env` or a Grok API key. `XAI_API_KEY` in `apps/agentservice/.env.example` is an empty placeholder.

## Docs

- [Overview](docs/overview.md) — product, track, boundaries
- [Getting started](docs/getting-started.md) — contributor workflow and stack choices
- [ADRs](adr/README.md) — decisions only; [ADR-001](adr/001-mock-verifier-grok.md) is the mock / verifier / Grok freeze

## Contracts

`packages/shared` exports the frozen shapes:

- **Trace** — steps, totals, fault, `outcome.verifier`, `diagnosis` (null until Grok writes it)
- **Agent** — instance, test instance, trace store, docs, tasks with `verifier_checks`
- **Run** — harness metadata (`phase`, `injection_plan_id`, `fix_*`, `trace_id`), not nested in Trace

Grok must not write `outcome.verifier` or `fault.labels`. The verifier, not the model, is the success signal.
