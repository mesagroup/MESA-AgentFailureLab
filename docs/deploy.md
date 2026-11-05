# Deploy

Four public web processes, one Postgres instance for agents, runs, and traces, no custom domain, no pull-request previews. Images are built from this repo. Secrets stay out of git. The shop stays a separate service. It is not folded into `apps/backend`. The same `DATABASE_URL` selects both stores. Backup, jury reset, cutover, and rollback are in [persistence.md](persistence.md). `render.yaml` declares Postgres `mesa-postgres` and sets `DATABASE_URL` on `mesa-backend` from the internal connection string. Yuri (diamanti-sg) applies that Blueprint in the Render workspace. The steps are [below](#apply-the-database-yuri).

| Service | Image | Port | Health |
| --- | --- | --- | --- |
| `mesa-frontend` | `apps/frontend/Dockerfile` | 3000 | `GET /health` |
| `mesa-backend` | `apps/backend/Dockerfile` | 3001 | `GET /health` |
| `mesa-agentservice` | `apps/agentservice/Dockerfile` | 3002 | `GET /health` |
| `mesa-mock-shop` | `services/mock-shop/Dockerfile` | 8787 | `GET /health` |

Build from the repository root. The Docker context is the monorepo so the workspace manifests are available. Docker reads the root `.dockerignore` only.

```bash
docker build -f apps/frontend/Dockerfile -t mesa-frontend .
docker build -f apps/backend/Dockerfile -t mesa-backend .
docker build -f apps/agentservice/Dockerfile -t mesa-agentservice .
docker build -f services/mock-shop/Dockerfile -t mesa-mock-shop .
```

The frontend image is nginx serving the Vite build. The backend, the agent service, and the mock shop run Node. The agent service runs `node --env-file-if-exists=.env dist/index.js`, so a missing file is fine and platform env vars still win. The other two Node images run `node dist/index.js`. All three listen on `0.0.0.0` (`HOST` in the image) as the `node` user. Local `pnpm dev` still defaults to `127.0.0.1`.

## Environment variables

Nothing in git has a real secret. `XAI_API_KEY=` in the agent service example is an empty placeholder.

| Variable | Where it is read | Secret | Local value | Render value |
| --- | --- | --- | --- | --- |
| `XAI_API_KEY` | agent service, runtime | yes | `apps/agentservice/.env` only | Dashboard prompt, `sync: false` |
| `XAI_BASE_URL` | agent service, runtime | no | `https://api.x.ai/v1` | same, in `render.yaml` |
| `GROK_MODEL` | agent service, runtime | no | `grok-3` | same, in `render.yaml` |
| `VITE_BACKEND_URL` | frontend, **build time** | no | `http://127.0.0.1:3001` | `https://mesa-backend-itm4.onrender.com` |
| `VITE_AGENTSERVICE_URL` | frontend, **build time** | no | `http://127.0.0.1:3002` | `https://mesa-agentservice.onrender.com` |
| `BACKEND_URL` | agent service, runtime | no | Compose: `http://mesa-backend:3001` | `https://mesa-backend-itm4.onrender.com` |
| `AGENTSERVICE_URL` | backend, runtime. Diagnosis and the `reference-shop` seed (`POST /v1/tasks/run`) | no | Compose: `http://mesa-agentservice:3002`. `pnpm dev`: `http://127.0.0.1:3002` | `https://mesa-agentservice.onrender.com` |
| `FRONTEND_URL` | backend, runtime, CORS allowlist. Also declared on the agent service, which does not read it | no | Compose: `http://mesa-frontend:3000` (in-network name; the browser origin is the published port — see [Browser CORS](#browser-cors)) | `https://mesa-frontend-rleq.onrender.com` |
| `MOCK_SHOP_URL` | backend, runtime. Shop runs, and `reference-shop` `world.base_url` at seed | no | Compose: `http://mesa-mock-shop:8787`. `pnpm dev`: `http://127.0.0.1:8787` | `https://mesa-mock-shop.onrender.com` (intended host; confirm after apply) |
| `LIBRARY_AGENT_URL` | backend, runtime. `external-library` seed (`POST /v1/tasks/run`) | no | Compose: `http://mesa-library-agent:3003`. `pnpm dev`: `http://127.0.0.1:3003` | `https://mesa-library-agent.onrender.com` (intended host; confirm after apply) |
| `MOCK_LIBRARY_URL` | backend, runtime. `external-library` `world.base_url`. Library runs call this origin | no | Compose: `http://mesa-mock-library:8788`. `pnpm dev`: `http://127.0.0.1:8788` | `https://mesa-mock-library.onrender.com` (intended host; confirm after apply) |
| `PORT` | all four | no | 3000 / 3001 / 3002 / 8787 | same values in the Blueprint |
| `HOST` | backend, agent service, and mock shop | no | `127.0.0.1` for `pnpm dev`; `0.0.0.0` in containers | `0.0.0.0` via env group `mesa-shared` |
| `NODE_ENV` | runtime | no | unset for `pnpm dev` | `production` via `mesa-shared` |
| `DATABASE_URL` | backend, runtime | yes (the URL contains the password) | unset for in-memory `pnpm dev`. Compose: `postgres://mesa:mesa@mesa-postgres:5432/mesa` | `fromDatabase` `connectionString` on `mesa-postgres` (internal URL). Not written in git |

`VITE_*` values are inlined when the frontend image is built. Changing them on a running container does nothing until the image is rebuilt. A browser cannot resolve Docker DNS names (`mesa-backend`) or Render's private hostname, so those URLs are the public ones.

`MOCK_SHOP_URL` is read only by the backend harness. `GET /health` on the backend reports it as `mock_base_url` and does not call the shop. The harness copies that value into `mock_base_url` on `POST /v1/tasks/run` for a shop agent. The agent service does not read `MOCK_SHOP_URL`, `SHOP_BASE_URL`, or any other shop base URL. It proposes actions and does not call the shop. There is no shop env var to set on `mesa-agentservice`.

`AGENTSERVICE_URL`, `MOCK_SHOP_URL`, `LIBRARY_AGENT_URL`, and `MOCK_LIBRARY_URL` are also written onto the seeded agents. The map for `pnpm dev`, Compose, and Render is [seed-endpoints.md](seed-endpoints.md). `NODE_ENV=production` refuses a loopback value for those four. A missing variable in production falls back to the public host in that doc, not to `127.0.0.1`.

The backend allows one mock writer per process. `POST /runs` and `POST /attacker/jury-case` take that gate and answer HTTP 409 `world_busy` when it is already held. Keep a single `mesa-backend` instance pointed at the demo shop. A second instance can reset the same shop during a live run. `GET /agents`, `GET /runs`, and `GET /traces` stay available on the busy instance. The gate leaves lab rows in place. The limit is described in [architecture.md](architecture.md#one-writer-for-the-mock-world).

The Dockerfiles do not declare `ARG` for `XAI_API_KEY` or `NODE_ENV`. Render passes service env vars in as Docker build args. An `ARG` with a secret name would store the secret in the image. `NODE_ENV=production` during `pnpm install` would also skip the devDependencies the build needs.

Copy examples when you need overrides. Do not commit the copies.

```bash
cp apps/frontend/.env.example apps/frontend/.env
cp apps/backend/.env.example apps/backend/.env
cp apps/agentservice/.env.example apps/agentservice/.env
# optional, only to change frontend image build args for Compose:
cp .env.example .env
```

Set `XAI_API_KEY` in `apps/agentservice/.env` when you want a real Grok call. Leave it empty until then. The scaffold boots either way. `GET /health` reports `grok_configured` and does not print the key.

## Docker Compose

`docker compose up --build` starts the four web processes and Postgres on the `mesa` network. It publishes ports 3000, 3001, 3002, and 8787 on the host, and Postgres on `127.0.0.1:5432`.

Service DNS names on that network:

- `http://mesa-frontend:3000`
- `http://mesa-backend:3001`
- `http://mesa-agentservice:3002`
- `http://mesa-mock-shop:8787`
- `mesa-postgres:5432` (Postgres, not HTTP)

Compose forces `HOST=0.0.0.0` and those DNS URLs for server-side calls, even if a copied `.env` still says `127.0.0.1`. That includes `MOCK_SHOP_URL=http://mesa-mock-shop:8787` on the backend. The frontend build args stay on `http://127.0.0.1:3001` and `:3002` so links in the browser hit the published ports. `apps/agentservice/.env` and `apps/backend/.env` are optional (`required: false`). When the agent service file exists, Compose loads it and does not override `XAI_API_KEY`.

`mesa-postgres` is Postgres 16. Compose sets the backend `DATABASE_URL` to `postgres://mesa:mesa@mesa-postgres:5432/mesa`, which wins over a copied `apps/backend/.env`. The published port is `127.0.0.1:5432`. User, password, and database name are `mesa`. That password is a local default. The data volume is `mesa-pgdata`. The backend waits until `pg_isready` succeeds, then applies `apps/backend/migrations` (`001_agents.sql`, `002_runs.sql`, `003_traces.sql`) and seeds `reference-shop` and `external-library` when that id is missing. It rewrites a seed when the stored document fails the Agent schema, is older than the fixture, or is the same age with different runtime or world URLs. Compose sets those URLs to the service DNS names ([seed-endpoints.md](seed-endpoints.md)). Missing demo run and trace ids are inserted; present ids are kept. They stay in that volume across a backend restart. `docker compose down -v` deletes the volume. `pnpm --filter @mesa/backend db:reset -- --yes` deletes runs, traces, and non-seed agents, keeps the volume and both seed rows, and puts the demo traces back. Export and import use the same published URL. The procedure is in [persistence.md](persistence.md).

`pnpm dev:mock-shop` is still the loopback shop on port 8787. Compose does not use that address. `GET /health` does not call the shop. `GET /health` on the backend reports `agent_store` and `run_store` as `postgres` under Compose and `memory` when `DATABASE_URL` is unset.

## Render Blueprint

`render.yaml` is the Blueprint. Applying it creates or updates one project so the services are not scattered on the account:

- Project: `mesa-agent-failure-lab`
- Environment: `demo` (the only MVP environment; no staging)
- Services inside that environment: `mesa-frontend`, `mesa-backend`, `mesa-agentservice`, `mesa-mock-shop`
- Database inside that environment: `mesa-postgres` (Postgres 16, `plan: free`, Frankfurt). Agent, run, and trace rows. See [persistence.md](persistence.md)
- Plan: free web (spins down after about 15 minutes idle). The database plan is separate and is called out below
- Region: Frankfurt
- Runtime: Docker, context `.`, Dockerfile under `apps/<name>/Dockerfile` or `services/mock-shop/Dockerfile`
- Branch: `main`, auto-deploy on each commit to `main`
- Health check: `GET /health` on each service
- Previews: off (no preview environments, no per-service pull-request previews)
- Shared non-secrets: env group `mesa-shared` (`NODE_ENV`, `HOST`)

The Render workspace is `tea-dblh716417fc738hr7vg`. Yuri (diamanti-sg) owns it and applies this Blueprint. This repository does not create the resources. A merge syncs the Blueprint only when auto-sync is on. The steps below are his.

### Apply the database (Yuri)

The four web services are already in project `mesa-agent-failure-lab` / environment `demo`. This file adds Postgres `mesa-postgres` in that same environment and sets `DATABASE_URL` on `mesa-backend` only. `FRONTEND_URL`, `AGENTSERVICE_URL`, `MOCK_SHOP_URL`, `PORT`, and env group `mesa-shared` stay. The other three services are not given `DATABASE_URL`.

Export the live in-memory backend before any redeploy. A push to `main` restarts `mesa-backend` (`autoDeployTrigger: commit`) even when the Blueprint does not sync. That restart drops every agent except the seed, and every run and trace. Do this from a laptop while `GET /health` still reports `memory`. Keep the file. Do not commit it. The full command notes are in [persistence.md](persistence.md#render-memory-process-to-mesa-postgres).

```powershell
pnpm --filter @mesa/backend db:export -- --base-url https://mesa-backend-itm4.onrender.com --out mesa-backup.json
Invoke-RestMethod https://mesa-backend-itm4.onrender.com/health | Select-Object status, agent_store, run_store
```

`agent_store` and `run_store` should both be `memory` on that check. If the service was already restarted, the file only has what is still in the process.

Merging this file to `main` syncs the Blueprint only when auto-sync is on for that Blueprint. Auto-sync off means the merge updates git and does not create the database and does not set `DATABASE_URL`. Yuri then opens the Blueprint and runs Manual Sync. Either sync creates `mesa-postgres`, sets `DATABASE_URL` from the internal `connectionString`, and redeploys `mesa-backend`. That redeploy is the restart that leaves memory behind. Import only after health shows `postgres`.

Dashboard, in workspace `tea-dblh716417fc738hr7vg`:

1. Open the [Render Dashboard](https://dashboard.render.com) and select that workspace.
2. Open the existing Blueprint for `mesagroup/MESA-AgentFailureLab` (`render.yaml` on `main`). Do not create a second Blueprint. A second one can try to adopt the same service names.
3. If the Blueprint is not connected yet, use **New** → **Blueprint**, connect the repo, and point it at `render.yaml` on `main`. That path is the first create, not the path for the database on an already connected Blueprint.
4. Read the plan before you confirm it. You should see Postgres `mesa-postgres` (`plan: free`, region Frankfurt, Postgres 16) inside environment `demo`, and `DATABASE_URL` on `mesa-backend` from `fromDatabase` property `connectionString`. You should not see a disk, a custom domain, a preview environment, or new env vars on the other three services. `plan: free` is 0.1 CPU / 256 MB. Stop if the plan is something else, or if the workspace already has a different free Postgres (one free database per workspace). If this workspace rejects `free`, change `plan` to `0.1c-256mb` in `render.yaml` and sync again. That plan id is the same CPU and RAM without the 30-day expiry. The older name for that size is `basic-256mb`.
5. `XAI_API_KEY` is `sync: false`. A sync of an existing Blueprint does not prompt for it and does not overwrite it. On a first create, paste the key or leave it blank. Do not put the key in git.
6. If auto-sync is off, run Manual Sync after the merge is on `main`. If auto-sync is on, the merge already started the sync. Confirm the plan, then apply.
7. Apply. Render creates the database and redeploys `mesa-backend`. The first request after idle can take about a minute because the free web service spins down. The internal URL is what the service uses. A free web service can send private-network requests to a database in the same region.
8. Open `mesa-mock-shop` only if its public URL is still unset. If it is not `https://mesa-mock-shop.onrender.com`, set `MOCK_SHOP_URL` in `render.yaml` to the assigned `https://` URL and sync again. Leave the Dashboard and the file on the same host.

### Verify

After the sync, both stores must be `postgres`. If either is `memory`, `DATABASE_URL` is not on the service. Do not import yet.

```powershell
Invoke-RestMethod https://mesa-backend-itm4.onrender.com/health | Select-Object status, agent_store, run_store
```

```bash
curl -fsS https://mesa-backend-itm4.onrender.com/health
```

The health JSON includes `agent_store` and `run_store`. Both values are `postgres` when the internal URL is set and the process booted. `status` stays `ok`. The first call after idle can be slow.

Then import `mesa-backup.json` with the **external** connection string from the `mesa-postgres` page in the Dashboard. The internal `connectionString` is not reachable from a laptop. Free web services have no shell, so import stays on the laptop. Commands, the TLS note, and the order (export, then redeploy, then import) are in [persistence.md](persistence.md#render-memory-process-to-mesa-postgres).

### 30-day expiry

The free database expires 30 days after Render creates it. It then has 14 days to be upgraded. After that grace period Render deletes the database and its data. The free plan has no backups, storage is 1 GB, and a workspace can have one free Postgres. The clock starts at creation, not at the merge. Set a reminder for that date and run `db:export` before it. Render also emails as the date gets close. The JSON file is the copy that survives the delete. The limits are in [persistence.md](persistence.md#render-free-postgres-limits) ([Deploy for Free](https://render.com/docs/free)). Smontuor's note on the issue was to create this database close to the demo, because the seed inserts itself, and to move off `free` if the lab has to last longer than 30 days.

### Rollback

Remove `DATABASE_URL` from `mesa-backend` in the Dashboard and redeploy that service. The next boot is in memory. `GET /health` shows `memory` for both stores. The Postgres rows stay until the database is deleted or the free plan expires. Export before you drop the database.

```powershell
Invoke-RestMethod https://mesa-backend-itm4.onrender.com/health | Select-Object status, agent_store, run_store
```

The next Blueprint sync puts `DATABASE_URL` back, because `render.yaml` still declares `fromDatabase`. To stay on memory across syncs, remove that env var from `render.yaml` and sync again. Local rollback is `Remove-Item Env:DATABASE_URL` and is written in [persistence.md](persistence.md#rollback).

### Public hosts

`render.yaml` stores the public URLs. Render already assigned the first three in workspace `tea-dblh716417fc738hr7vg`. `mesa-agentservice` kept `https://mesa-agentservice.onrender.com`. Frontend and backend received a suffix. The shop row is the intended host for the new service name.

| Service | Public URL |
| --- | --- |
| `mesa-frontend` | `https://mesa-frontend-rleq.onrender.com` |
| `mesa-backend` | `https://mesa-backend-itm4.onrender.com` |
| `mesa-agentservice` | `https://mesa-agentservice.onrender.com` |
| `mesa-mock-shop` | `https://mesa-mock-shop.onrender.com` (intended; confirm after apply) |
| `mesa-library-agent` | `https://mesa-library-agent.onrender.com` (intended; confirm after apply) |
| `mesa-mock-library` | `https://mesa-mock-library.onrender.com` (intended; confirm after apply) |

`mesa-frontend`, `mesa-backend`, and `mesa-agentservice` are the hosts Render already assigned in workspace `tea-dblh716417fc738hr7vg`. `mesa-mock-shop` is the public URL for the service name. That hostname was not bound to a service when this file was written. Frontend and backend received a suffix; the agent service kept its name. After apply, if the shop slug differs, replace `MOCK_SHOP_URL` with the assigned `https://…onrender.com` URL. That is the same update [PR #39](https://github.com/mesagroup/MESA-AgentFailureLab/pull/39) made for the other hosts.

A Blueprint sync writes every env var declared in `render.yaml`. `XAI_API_KEY` is the exception (`sync: false`). The next sync copies `VITE_BACKEND_URL`, `VITE_AGENTSERVICE_URL`, `BACKEND_URL`, `AGENTSERVICE_URL`, `FRONTEND_URL`, `MOCK_SHOP_URL`, `LIBRARY_AGENT_URL`, and `MOCK_LIBRARY_URL` from this file onto the services. It also refreshes `DATABASE_URL` from `mesa-postgres`. The password stays on the Render database, not in git. Keep the Dashboard and `render.yaml` on these hosts. If Render changes a slug, update both before the next sync.

After a URL change, redeploy `mesa-frontend` so Vite bakes `VITE_BACKEND_URL` and `VITE_AGENTSERVICE_URL`. `BACKEND_URL`, `AGENTSERVICE_URL`, `FRONTEND_URL`, `MOCK_SHOP_URL`, `LIBRARY_AGENT_URL`, `MOCK_LIBRARY_URL`, and `DATABASE_URL` are read at runtime; a restart picks them up. The four seed URLs are described in [seed-endpoints.md](seed-endpoints.md). The backend uses `FRONTEND_URL` as its browser CORS allowlist. See [Browser CORS](#browser-cors). Set `XAI_API_KEY` in the Dashboard when you want Grok calls. The agent service still has no shop URL.

Confirm:

```bash
curl -fsS https://mesa-frontend-rleq.onrender.com/health
curl -fsS https://mesa-backend-itm4.onrender.com/health
curl -fsS https://mesa-agentservice.onrender.com/health
curl -fsS https://mesa-mock-shop.onrender.com/health
```

The shop curl uses the intended host. Use the Dashboard URL if Render assigned a suffix. The backend health body should show `mock_base_url` as that same `https://` shop URL.

## Browser CORS

The deployed UI at `https://mesa-frontend-rleq.onrender.com` calls `https://mesa-backend-itm4.onrender.com` from the browser. `apps/frontend/src/lib/api.ts` sets `Content-Type: application/json` on every request, including GET. That header is not a CORS-safelisted content type, so the browser sends an `OPTIONS` preflight before the real call. `apps/backend` used to have no CORS plugin, so that `OPTIONS` fell through to the 404 handler and the browser blocked POST, PUT, DELETE, and any call that sent `content-type`.

`apps/backend/src/app.ts` registers `@fastify/cors`. The allowlist is never `*`.

`FRONTEND_URL` is read when the process starts. Split it on commas. Each token is trimmed. A trailing slash is dropped. Only `http` and `https` URLs are kept, and the value stored is the URL's origin (scheme, host, and port). `*` is ignored, so a bad token cannot open the API. Two local origins are always added, including when `FRONTEND_URL` is unset or empty:

- `http://127.0.0.1:3000`
- `http://localhost:3000`

Those are the origins a browser actually sends for this frontend. `apps/frontend/vite.config.ts` sets both `server.port` and `preview.port` to 3000 with `strictPort: true`. `apps/frontend/package.json` runs `vite --port 3000 --strictPort` and `vite preview --port 3000 --strictPort`. `docker-compose.yml` publishes `3000:3000` for `mesa-frontend`. The frontend README documents `http://127.0.0.1:3000`. The same server opened as `http://localhost:3000` sends the `localhost` origin. The allowlist uses that port. Vite's unused default of 5173 is not configured here.

Compose also sets `FRONTEND_URL=http://mesa-frontend:3000`. That hostname resolves only on the Compose network. It is not the `Origin` header of a page opened on the host. The two port-3000 entries above cover that browser. On Render, `render.yaml` already sets `FRONTEND_URL=https://mesa-frontend-rleq.onrender.com` on `mesa-backend`. This change reads that value. It does not edit the Blueprint. Add another origin by appending it, comma-separated, and restart `mesa-backend`. A frontend rebuild is not required for this variable.

Allowed methods are `GET`, `POST`, `PUT`, `DELETE`, and `OPTIONS`. The allowed request header is `content-type`. A preflight whose `Origin` is on the allowlist returns 204 with `Access-Control-Allow-Origin` set to that exact origin, `Access-Control-Allow-Methods` listing those methods, and `Access-Control-Allow-Headers: content-type`. Any other origin gets no `Access-Control-Allow-Origin` header. The server still answers a normal `GET` (for example `GET /health` with no `Origin`) so curl and the health check keep working.

The current UI does not call the agent service from the browser. `VITE_AGENTSERVICE_URL` is baked into the frontend image and declared in `apps/frontend/src/vite-env.d.ts`, and `docs/architecture.md` draws a UI arrow to that service, but no module under `apps/frontend/src` reads it. `apps/agentservice/src/app.ts` is Fastify and does not register CORS. Nothing in that package reads `FRONTEND_URL`, even though Compose, `render.yaml`, and `apps/agentservice/.env.example` set the variable. A later browser call to `https://mesa-agentservice.onrender.com` would fail its preflight the same way until CORS is added there. That service is owned by ercoleMesa and is not changed here. `apps/backend/src/reference-agent.ts` loads a fixture. It is not an HTTP server. `apps/backend/src/agents/` is the agent CRUD on this backend, and the CORS plugin covers those routes.

### Check after deploy

The free web plan sleeps. The first request after idle can be slow. Run the preflight again once `GET /health` answers.

```bash
curl -i -X OPTIONS https://mesa-backend-itm4.onrender.com/agents \
  -H "Origin: https://mesa-frontend-rleq.onrender.com" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type"
```

Expect `HTTP/2 204` (or `HTTP/1.1 204`) and this header:

```text
access-control-allow-origin: https://mesa-frontend-rleq.onrender.com
```

The same request with `Origin: https://evil.example` stays 204 and has no `access-control-allow-origin` header. `GET /health` stays 200.

PowerShell (`Invoke-WebRequest -Method Options`):

```powershell
$response = Invoke-WebRequest -Method Options `
  -Uri "https://mesa-backend-itm4.onrender.com/agents" `
  -Headers @{
    Origin = "https://mesa-frontend-rleq.onrender.com"
    "Access-Control-Request-Method" = "POST"
    "Access-Control-Request-Headers" = "content-type"
  }
$response.StatusCode
$response.Headers["Access-Control-Allow-Origin"]
```

Expect status `204` and `https://mesa-frontend-rleq.onrender.com`.

Against a local `pnpm dev:backend`, use the same headers with `http://127.0.0.1:3001/agents` and `Origin: http://127.0.0.1:3000`. That origin is allowed even when `FRONTEND_URL` is unset.

GitHub Actions does not deploy and does not need `XAI_API_KEY`. `.github/workflows/ci.yml` runs on pull requests and on pushes to `main`: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm test`, `pnpm eval:gate`, `docker compose config`, and a Docker build of each image plus a local `GET /health`. `pnpm eval:gate` reruns the deterministic rules baseline and fails when those rates differ from `apps/agentservice/eval/baseline.json` by more than `max_rate_drop` (see [eval](eval.md)). The step sets `XAI_API_KEY` empty, so Grok is skipped. It does not push images. Render's own auto-deploy from `main` is separate (`autoDeployTrigger: commit`). A red CI run does not block that deploy.

Free-plan builds are filtered so a docs-only commit does not rebuild every image. A change under `packages/shared`, the root workspace manifests, that service's `apps/<name>/` directory, or `services/mock-shop/` does rebuild the image that lists that path. The shop image does not list `packages/shared`, because `@mesa/mock-shop` does not import it.
