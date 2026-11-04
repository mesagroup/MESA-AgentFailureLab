# MESA Agent Failure Lab

Monorepo for Track 03 — Agent Failure Lab / CHAOS.AI. Frontend, Backend, and the AI Engineer each get an app. Contracts, product docs, and architecture decisions sit outside those apps.

The lab runs a shopping agent against a mock store, scores the task with a deterministic verifier, and uses Grok only to diagnose failures and propose fixes. A fix counts after the harness replays it and the verifier agrees. Details: [docs/overview.md](docs/overview.md) and [ADR-001](adr/001-mock-verifier-grok.md).

## Monorepo map

```
/
  apps/
    frontend/        # web UI — registration, runs, timeline
    backend/         # harness, verifier, injector, persistence
    agentservice/    # Grok reference agent, diagnosis, fix proposals
  services/
    mock-shop/       # inspectable e-commerce API for T1–T5
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
| [`apps/backend`](apps/backend/README.md) | Backend | Harness phases, deterministic verifier, labeled injector, in-memory Run/Trace persistence. No auth. |
| [`services/mock-shop`](services/mock-shop/README.md) | Backend | Mock shop: catalog, cart, checkout, cancel, `GET /internal/state`. Not inside `apps/backend`. |
| [`apps/agentservice`](apps/agentservice/README.md) | AI Engineer | Reference agent and Grok diagnosis. Writes `diagnosis` only. |
| [`packages/shared`](packages/shared/README.md) | All | Shared contracts. JSON Schema is the source of truth for Trace, Agent, and Run. |
| [`docs/`](docs/README.md) | All | Overview and contributor guide. |
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

## Docs

- [Overview](docs/overview.md) — product, track, boundaries
- [Getting started](docs/getting-started.md) — contributor workflow and stack choices
- [ADRs](adr/README.md) — decisions only; [ADR-001](adr/001-mock-verifier-grok.md) is the mock / verifier / Grok freeze

## Contracts

`packages/shared` exports the frozen shapes. `outcome.verifier` is the only pass/fail authority. `diagnosis` stays null until Grok writes it, and Grok must not write `outcome.verifier` or `fault.labels`.

- **Trace** — steps, per-step timings and costs, totals, `outcome.verifier`, fault labels, `diagnosis`
- **Agent** — instance, test instance, trace store, docs, tasks with `verifier_checks` (the reference stub has T1–T5)
- **Run** — harness metadata (`phase`, `injection_plan`, `fix_kinds`, `trace_ids`), not nested in Trace
