# @mesa/agentservice

Grok reference agent, diagnosis, and fix proposals. This package will read a `Trace`, optionally pre-check mechanical problems (loops, timeouts, repeated tools), and write `diagnosis` (`category`, `cause`, `step_id`, `confidence`, `evidence`, `proposed_fixes`).

This directory is a scaffold: Fastify boots, and `GET /health` answers. It does not call Grok. No API key is stored in the repo.

## Run from the monorepo root

```bash
pnpm install
pnpm exec turbo run dev --filter=@mesa/agentservice
```

Equivalent root script: `pnpm dev:agentservice`.

- Dev server: http://127.0.0.1:3002
- Health: http://127.0.0.1:3002/health
- Production build: `pnpm exec turbo run build --filter=@mesa/agentservice` then `pnpm --filter @mesa/agentservice start`

Copy `apps/agentservice/.env.example` to `apps/agentservice/.env` and set `XAI_API_KEY` locally when a real client is added. `.env` is gitignored. `XAI_API_KEY=` in the example must stay empty.

Container image, from the repo root: `docker build -f apps/agentservice/Dockerfile -t mesa-agentservice .` The image sets `HOST=0.0.0.0`, listens on port 3002, and answers `GET /health`. The key is a runtime env var, not a Docker build arg. See [docs/deploy.md](../../docs/deploy.md).

`turbo run dev` builds `@mesa/shared` first.

## Boundaries

Health reports `forbidden_write_paths` from `@mesa/shared`. Grok must not write:

- `outcome.verifier` (backend verifier only; it reads mock state, not the model)
- `fault.injected`, `fault.labels`, `fault.attacker` (injector / attacker only)

`diagnosis` stays `null` on a trace until this service fills it. `diagnosis.category` is a hypothesis. Ground truth for classification is `fault.labels`.

The backend harness applies a fix, replays the task (`Run.phase = after_fix`), and records `fix_*`. A proposal is valid only when that replay's verifier passes. This service may later turn a `proposed_fix` into a concrete patch the harness can apply. It does not declare success. See [ADR-001](../../adr/001-mock-verifier-grok.md).

## Where later code goes

- `src/grok/` — API client. Read the key from the environment at runtime.
- `src/diagnosis/` — trace reading and the diagnosis writer
- `src/reference-agent/` — the in-lab shopping agent (`instance.kind = reference`)
- `src/fixes/` — map a proposed fix to something the harness can apply

Do not put ADRs or product docs in this app. Use `adr/` and `docs/`.
