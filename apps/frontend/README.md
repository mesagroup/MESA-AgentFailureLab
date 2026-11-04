# @mesa/frontend

Web UI for agent registration, runs, and the trace timeline. Vite and React. The page you get today is a scaffold: it shows which app owns which surface and which shared contract version is linked. It does not call the backend.

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

## Where later code goes

- `src/pages/` — registration, run list, trace timeline
- `src/api/` — clients for `@mesa/backend` and `@mesa/agentservice`

Keep product docs in `docs/` and architecture decisions in `adr/`. See [ADR-001](../../adr/001-mock-verifier-grok.md): the timeline is the trace; before/after is the run plus the verifier.
