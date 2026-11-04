# Getting started

Work in the app you own. Shared contracts and docs stay outside the apps so the three teams do not edit the same package for day-to-day features.

## Prerequisites

- Node.js 22.12 or newer
- pnpm 10.33.4 (the version pinned in the root `packageManager` field)

Enable Corepack if `pnpm` is not already on your PATH:

```bash
corepack enable
corepack prepare pnpm@10.33.4 --activate
```

## Install and build

From a clean clone, at the repository root:

```bash
pnpm install
pnpm build
```

`pnpm build` is `turbo run build`. It compiles `@mesa/shared` first, then the apps and `@mesa/mock-shop`. `pnpm typecheck` and `pnpm test` run the same graph.

## Run one app

Use a filter so you do not start the other teams' dev servers:

```bash
pnpm exec turbo run dev --filter=@mesa/frontend
pnpm exec turbo run dev --filter=@mesa/backend
pnpm exec turbo run dev --filter=@mesa/agentservice
pnpm exec turbo run dev --filter=@mesa/mock-shop
```

Root aliases: `pnpm dev:frontend`, `pnpm dev:backend`, `pnpm dev:agentservice`, `pnpm dev:mock-shop`. `pnpm dev` starts every package that has a dev script.

| App | URL | Health |
| --- | --- | --- |
| `@mesa/frontend` | http://127.0.0.1:3000 | the page itself |
| `@mesa/backend` | http://127.0.0.1:3001 | `GET /health` |
| `@mesa/agentservice` | http://127.0.0.1:3002 | `GET /health` |
| `@mesa/mock-shop` | http://127.0.0.1:8787 | `GET /health` |

Each app README repeats the filter command and lists where new modules should go.

## Environment

Copy an app's `.env.example` to `.env` in that same directory when you need to override ports or, for the agent service, set a Grok key.

- Placeholders only. Do not commit `.env`.
- `XAI_API_KEY` stays empty in git. Put a real key in `apps/agentservice/.env` or the host secret store.
- There is no auth configuration. The MVP does not grow an auth stub.

The dev servers also start with built-in defaults if those variables are unset.

Containers and the Render project are a separate path. Images listen on `0.0.0.0` and on ports 3000, 3001, and 3002. Variable names, Compose DNS, and the Blueprint apply steps are in [Deploy](deploy.md). Do not commit a filled-in `.env`.

## Where to write

| You are changing… | Put it in… |
| --- | --- |
| UI | `apps/frontend` |
| Mock shop HTTP API (catalog, cart, orders, inspect) | `services/mock-shop` |
| Verifier, harness, storage | `apps/backend` |
| Grok client, diagnosis, fix applicator, replay | `apps/agentservice` |
| A field on Trace, Agent, or Run | `packages/shared` — edit the JSON Schema first, then the TypeScript mirror, then bump `CONTRACT_VERSION` |
| Product or contributor docs | `docs/` |
| An architecture decision | `adr/NNN-kebab-title.md` (see [`adr/README.md`](../adr/README.md)) |

Do not file ADRs under `docs/` or inside an app.

## Stack choices

These are scaffolds, not product features. Teams can replace a framework inside their own app without moving the contracts.

- Frontend: Vite 7 and React 19.
- Backend and agent service: Fastify 5, TypeScript, run in dev with `tsx`.
- Workspace: pnpm. Task graph: Turborepo.
- Language: TypeScript, except JSON Schema and Markdown.
