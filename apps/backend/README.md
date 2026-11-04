# @mesa/backend

Mock e-commerce API, deterministic verifier, and harness runner. This package owns world state (catalog, cart, orders, user permissions) and is the only writer of `outcome.verifier`. It also records harness `Run` metadata (`phase`, `injection_plan_id`, `fix_*`, `trace_id`).

This directory is a scaffold: Fastify boots, and `GET /health` answers. There is no mock catalog, no verifier, no persistence, and no auth.

## Run from the monorepo root

```bash
pnpm install
pnpm exec turbo run dev --filter=@mesa/backend
```

Equivalent root script: `pnpm dev:backend`.

- Dev server: http://127.0.0.1:3001
- Health: http://127.0.0.1:3001/health
- Production build: `pnpm exec turbo run build --filter=@mesa/backend` then `pnpm --filter @mesa/backend start`

Copy `apps/backend/.env.example` to `apps/backend/.env` to override `PORT` or `HOST`. Real env files are gitignored. Do not commit database URLs.

`turbo run dev` builds `@mesa/shared` first. Contracts come from that package. JSON Schema is the source of truth for Trace and Agent.

## Boundaries

- The verifier is deterministic. It reads mock state and `success_test.checks`. It does not call Grok and it does not score trace prose.
- Grok (in `@mesa/agentservice`) must not write `outcome.verifier` or `fault.labels`.
- Fault labels and `attacker` are written by the injector on chaos runs.
- A fix counts only after this harness replays the task (`phase: after_fix`) and the verifier passes. See [ADR-001](../../adr/001-mock-verifier-grok.md).

## Where later code goes

Keep new modules inside this app so the other packages stay independent:

- `src/mock/` — e-commerce world and the inspect API the verifier reads
- `src/verifier/` — check runner over mock state
- `src/harness/` — baseline / injected / after_fix phases and `Run` persistence
- `src/persistence/` — trace and run storage

Do not put ADRs or product docs in this app. Use `adr/` and `docs/`.
