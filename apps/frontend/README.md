# @mesa/frontend

Web UI for agent registration, runs, and the trace timeline. Vite and React.

The dashboard (`/`) reads the harness session from `GET /agents` and `GET /runs` (`VITE_BACKEND_URL`; unset, the dev server uses `/api` and proxies it to the backend). Cards use `counts` with `scope` `harness_session`. Run rows use `Run.status`, `trace_ids`, and `trace_links[].outcome.verifier`. There is no `result` field and no 90-day series. A row with `first_trace_id` opens `/traces/:traceId`. A row without one opens `/runs/:runId`. Agent registration, the runs list, and the trace timeline call the same harness.

The timeline renders `Trace`. Before/after comparisons will use harness `Run` records plus `outcome.verifier`. This app does not decide task success.

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

## Agents form

Create and edit store `tasks[].evalset` and optional `Agent.otel` through `POST /agents` and `PUT /agents/:agent_id`. Evalset cases are judge input for a later Grok read of that task's Trace or Run. They do not replace the verifier. There is no generate-evalset control (#121).

The agent page pastes or uploads a version 1 span batch to `POST /agents/:agentId/otel/import` and opens the stored Trace. The form stores `auth.token_env` as an environment variable name and never sends a bearer token. Import does not call the source endpoint and does not invent `fault.labels` or `outcome.verifier`. See [docs/otel.md](../../docs/otel.md).
