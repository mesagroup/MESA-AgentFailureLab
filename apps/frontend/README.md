# @mesa/frontend

Web UI for agent registration, runs, and the trace timeline. Vite and React.

The dashboard (`/`) reads the harness session from `GET /agents` and `GET /runs` (`VITE_BACKEND_URL`, default `http://127.0.0.1:3001`). Cards use `counts` with `scope` `harness_session`. Run rows use `Run.status`, `trace_ids`, and `trace_links[].outcome.verifier`. There is no `result` field and no 90-day series. A row with `first_trace_id` opens `/traces/:traceId`. A row without one opens `/runs/:runId`. Agent registration calls the same harness. The run launcher and the trace timeline are still scaffolds.

The timeline will render `Trace`. Before/after comparisons will use harness `Run` records plus `outcome.verifier`. This app does not decide task success.

## Run from the monorepo root

```bash
pnpm install
pnpm exec turbo run dev --filter=@mesa/frontend
```

Equivalent root script: `pnpm dev:frontend`.

- Dev server: http://127.0.0.1:3000
- Production build: `pnpm exec turbo run build --filter=@mesa/frontend`
- Preview the build: `pnpm --filter @mesa/frontend preview`

`turbo run dev` builds `@mesa/shared` first so the UI can import `CONTRACT_VERSION`.

Copy `apps/frontend/.env.example` to `apps/frontend/.env` to point the UI at other hosts. Only `VITE_` variables are exposed to the browser. There is no auth config in this scaffold.

Container image, from the repo root: `docker build -f apps/frontend/Dockerfile -t mesa-frontend .` The image listens on port 3000 and answers `GET /health`. `VITE_BACKEND_URL` and `VITE_AGENTSERVICE_URL` are baked in at build time. See [docs/deploy.md](../../docs/deploy.md).

## Where later code goes

- `src/pages/` — registration, run list, trace timeline
- `src/api/` — clients for `@mesa/backend` and `@mesa/agentservice`

Keep product docs in `docs/` and architecture decisions in `adr/`. See [ADR-001](../../adr/001-mock-verifier-grok.md): the timeline is the trace; before/after is the run plus the verifier.
