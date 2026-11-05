# @mesa/frontend

Web UI for agent registration, runs, and the trace timeline. Vite and React.

The dashboard (`/`) reads the harness session from `GET /agents` and `GET /runs` (`VITE_BACKEND_URL`; unset, the dev server uses `/api` and proxies it to the backend). Cards use `counts` with `scope` `harness_session`. Run rows use `Run.status`, `trace_ids`, and `trace_links[].outcome.verifier`. There is no `result` field and no 90-day series. A row with `first_trace_id` opens `/traces/:traceId`. A row without one opens `/runs/:runId`. Agent registration, the runs list, and the trace timeline call the same harness.

The timeline renders `Trace`. This app does not decide task success. Before/after uses `outcome.verifier` and `totals` from the parent and child traces.

### Issue #53 — select fixes, after_fix replay, before/after

The Analysis panel is always on `/traces/:traceId` (`#analysis`). When `diagnosis` is absent, **Run diagnosis** posts `POST /traces/:id/diagnose`. When it is present, the panel shows cause, failing `step_id`, confidence, and `proposed_fixes`. Lab boot seeds `trace-t3-forged-checkout` already diagnosed for demo scenes 6–8.

Scene 8 stays on that trace after **Replay after_fix** (`#after-fix`). Before/after is `outcome.verifier` of `run-t3-injected-001` versus the new child. Recovered checks are listed. Links open the child run and trace.

On `/traces/:traceId`, choose `diagnosis.proposed_fixes` (`FixKind[]`: `controlled_retry`, `pre_response_check`, `permission_guard` — there is no `fault_kinds`). The ADR-002 default for `diagnosis.category` is highlighted via `adrFixForCategory`. Replay calls `POST /runs` with `{ agent_id, phase: "after_fix", parent_run_id, fix_kinds }` and omits `injection` so the harness copies the parent fault (`injection: null` is the clean treated control). The side-by-side view reads `results[0].parent.trace.outcome.verifier` / `.totals` versus `results[0].trace`, plus `results[0].links` (`run`, `trace`, `parent_run`, `parent_trace`). Reloads also use `GET /runs` `trace_links[].parent_run_id` / `child_run_ids`. Out of scope: #103 diagnosis panel, #119, #121.

The jury page (`/jury`) is the structured malicious-note demo. It reads `GET /attacker/jury-case`. When `frontend` is present it supplies the default task, the trace route, and the replay fix; otherwise the page uses `structured`, then the case fields. The POST body sends `permissions` from the control. A name that appears only in the note is not added. The page shows `outcome.verifier`, `baseline_comparison`, and `fault.attacker`. Ispeziona traccia maps `links.attacked_trace` onto `/traces/:traceId`. A frozen baseline leaves `links.baseline_trace` null and is not opened. Replay sends `fix_kinds: ["permission_guard"]` with `parent_run_id` of the injected run. HTTP 409 `world_busy` asks for a retry and is not a verifier failure. `diagnosis` on this POST stays null.

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

Create and edit store `tasks[].evalset` and optional `Agent.otel` (`prod` + `test` sources) through `POST /agents` and `PUT /agents/:agent_id`. The task form derives shop vs library from setup/checks (not `world.kind`): cart UI for shop, library loans for library. Evalset cases are judge input for a later Grok read of that task's Trace or Run. They do not replace the verifier. **Genera evalset** / **Modifica con AI** call `POST /evalset/generate` on the harness (which proxies agentservice). The proposal lands in the form. Save still uses Agent CRUD. The browser never receives `XAI_API_KEY`.

The Agents page OTel tab is open-lab: dual prod/test URLs with `auth.type: none` (no bearer UI). Save keeps an existing `schema_id`. Paste/upload of a version 1 span batch (edit only) posts to `POST /agents/:agentId/otel/import` and opens the stored Trace. Import does not call the source endpoint and does not invent `fault.labels` or `outcome.verifier` (ADR-001). Schema remap editor UI stays on #120. See [docs/otel.md](../../docs/otel.md).

Traces (`/traces`) lists `GET /traces` with source tags `harness`, `demo_seed`, `otel_prod`, and `otel_test`. Filters are `agent_id`, `source`, `since`, and `until`. **Pull traces** on that page and on an agent row calls `POST /agents/:agentId/traces/pull`. A blank start time omits `since`, so the first pull fetches the full seed and a later pull uses `last_pull_at` from `GET /agents/:agentId/otel/cursors`. The page shows imported, skipped, and failed counts, an empty window, and `errors[].message` for network, auth, remap, validation, and conflict, then reloads the list. See [docs/otel.md](../../docs/otel.md#frontend).
