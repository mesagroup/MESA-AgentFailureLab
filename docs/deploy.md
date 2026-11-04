# Deploy

Four public web processes, no database, no custom domain, no pull-request previews. Images are built from this repo. Secrets stay out of git. The shop stays a separate service. It is not folded into `apps/backend`.

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
| `AGENTSERVICE_URL` | backend, runtime | no | Compose: `http://mesa-agentservice:3002` | `https://mesa-agentservice.onrender.com` |
| `FRONTEND_URL` | backend and agent service, runtime | no | Compose: `http://mesa-frontend:3000` | `https://mesa-frontend-rleq.onrender.com` |
| `MOCK_SHOP_URL` | backend, runtime | no | Compose: `http://mesa-mock-shop:8787`. `pnpm dev`: `http://127.0.0.1:8787` | `https://mesa-mock-shop.onrender.com` (intended host; confirm after apply) |
| `PORT` | all four | no | 3000 / 3001 / 3002 / 8787 | same values in the Blueprint |
| `HOST` | backend, agent service, and mock shop | no | `127.0.0.1` for `pnpm dev`; `0.0.0.0` in containers | `0.0.0.0` via env group `mesa-shared` |
| `NODE_ENV` | runtime | no | unset for `pnpm dev` | `production` via `mesa-shared` |

`VITE_*` values are inlined when the frontend image is built. Changing them on a running container does nothing until the image is rebuilt. A browser cannot resolve Docker DNS names (`mesa-backend`) or Render's private hostname, so those URLs are the public ones.

`MOCK_SHOP_URL` is read only by the backend harness. `GET /health` on the backend reports it as `mock_base_url` and does not call the shop. The harness copies that value into `mock_base_url` on `POST /v1/tasks/run`. The agent service does not read `MOCK_SHOP_URL`, `SHOP_BASE_URL`, or any other shop base URL. It proposes actions and does not call the shop. There is no shop env var to set on `mesa-agentservice`.

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

`docker compose up --build` starts all four on the `mesa` network and publishes ports 3000, 3001, 3002, and 8787 on the host.

Service DNS names on that network:

- `http://mesa-frontend:3000`
- `http://mesa-backend:3001`
- `http://mesa-agentservice:3002`
- `http://mesa-mock-shop:8787`

Compose forces `HOST=0.0.0.0` and those DNS URLs for server-side calls, even if a copied `.env` still says `127.0.0.1`. That includes `MOCK_SHOP_URL=http://mesa-mock-shop:8787` on the backend. The frontend build args stay on `http://127.0.0.1:3001` and `:3002` so links in the browser hit the published ports. `apps/agentservice/.env` and `apps/backend/.env` are optional (`required: false`). When the agent service file exists, Compose loads it and does not override `XAI_API_KEY`.

There is no Postgres service. `pnpm dev:mock-shop` is still the loopback shop on port 8787. Compose does not use that address. `GET /health` does not call the shop.

## Render Blueprint

`render.yaml` is the Blueprint. Applying it creates or updates one project so the services are not scattered on the account:

- Project: `mesa-agent-failure-lab`
- Environment: `demo` (the only MVP environment; no staging)
- Services inside that environment: `mesa-frontend`, `mesa-backend`, `mesa-agentservice`, `mesa-mock-shop`
- Plan: free web (spins down after about 15 minutes idle)
- Region: Frankfurt
- Runtime: Docker, context `.`, Dockerfile under `apps/<name>/Dockerfile` or `services/mock-shop/Dockerfile`
- Branch: `main`, auto-deploy on each commit to `main`
- Health check: `GET /health` on each service
- Previews: off (no preview environments, no per-service pull-request previews)
- Shared non-secrets: env group `mesa-shared` (`NODE_ENV`, `HOST`)

The intended Render workspace is `tea-dblh716417fc738hr7vg`. Pick that workspace in the Dashboard before you apply the Blueprint. This repository does not create the resources.

### Apply

1. Merge the Blueprint to `main` (Render reads the file from the connected repo).
2. Open the [Render Dashboard](https://dashboard.render.com), select the workspace above, then **New** → **Blueprint**.
3. Connect `mesagroup/MESA-AgentFailureLab` if it is not connected yet. Point the Blueprint at `render.yaml` on `main`.
4. Review the plan. You should see project `mesa-agent-failure-lab`, environment `demo`, and the four free Docker web services in Frankfurt. You should not see a database, a disk, a custom domain, or a preview environment.
5. When Render prompts for `XAI_API_KEY`, paste the key or leave it blank until Grok is wired. `sync: false` means this prompt happens on first create. Later Blueprint syncs do not overwrite the value. To rotate it, edit the service env var in the Dashboard. Do not put the key in git, in GitHub Actions, or in the Blueprint.
6. Apply. Render builds the four images and deploys them. The first request after idle can be slow because the free plan spins down.
7. Open `mesa-mock-shop` and read the public URL Render assigned. If it is not `https://mesa-mock-shop.onrender.com`, set `MOCK_SHOP_URL` in `render.yaml` to that URL and sync again. Leave the Dashboard and the file on the same host. The harness should use that public `https://` URL.

### Public hosts

`render.yaml` stores the public URLs. Render already assigned the first three in workspace `tea-dblh716417fc738hr7vg`. `mesa-agentservice` kept `https://mesa-agentservice.onrender.com`. Frontend and backend received a suffix. The shop row is the intended host for the new service name.

| Service | Public URL |
| --- | --- |
| `mesa-frontend` | `https://mesa-frontend-rleq.onrender.com` |
| `mesa-backend` | `https://mesa-backend-itm4.onrender.com` |
| `mesa-agentservice` | `https://mesa-agentservice.onrender.com` |
| `mesa-mock-shop` | `https://mesa-mock-shop.onrender.com` (intended; confirm after apply) |

`mesa-frontend`, `mesa-backend`, and `mesa-agentservice` are the hosts Render already assigned in workspace `tea-dblh716417fc738hr7vg`. `mesa-mock-shop` is the public URL for the service name. That hostname was not bound to a service when this file was written. Frontend and backend received a suffix; the agent service kept its name. After apply, if the shop slug differs, replace `MOCK_SHOP_URL` with the assigned `https://…onrender.com` URL. That is the same update [PR #39](https://github.com/mesagroup/MESA-AgentFailureLab/pull/39) made for the other hosts.

A Blueprint sync writes every env var declared in `render.yaml`. `XAI_API_KEY` is the exception (`sync: false`). The next sync copies `VITE_BACKEND_URL`, `VITE_AGENTSERVICE_URL`, `BACKEND_URL`, `AGENTSERVICE_URL`, `FRONTEND_URL`, and `MOCK_SHOP_URL` from this file onto the services. Keep the Dashboard and `render.yaml` on these hosts. If Render changes a slug, update both before the next sync.

After a URL change, redeploy `mesa-frontend` so Vite bakes `VITE_BACKEND_URL` and `VITE_AGENTSERVICE_URL`. `BACKEND_URL`, `AGENTSERVICE_URL`, `FRONTEND_URL`, and `MOCK_SHOP_URL` are read at runtime; a restart picks them up. Set `XAI_API_KEY` in the Dashboard when you want Grok calls. The agent service still has no shop URL.

Confirm:

```bash
curl -fsS https://mesa-frontend-rleq.onrender.com/health
curl -fsS https://mesa-backend-itm4.onrender.com/health
curl -fsS https://mesa-agentservice.onrender.com/health
curl -fsS https://mesa-mock-shop.onrender.com/health
```

The shop curl uses the intended host. Use the Dashboard URL if Render assigned a suffix. The backend health body should show `mock_base_url` as that same `https://` shop URL.

GitHub Actions does not deploy and does not need `XAI_API_KEY`. `.github/workflows/ci.yml` runs on pull requests and on pushes to `main`: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm test`, `pnpm eval:gate`, `docker compose config`, and a Docker build of each image plus a local `GET /health`. `pnpm eval:gate` reruns the deterministic rules baseline and fails when those rates differ from `apps/agentservice/eval/baseline.json` by more than `max_rate_drop` (see [eval](eval.md)). The step sets `XAI_API_KEY` empty, so Grok is skipped. It does not push images. Render's own auto-deploy from `main` is separate (`autoDeployTrigger: commit`). A red CI run does not block that deploy.

Free-plan builds are filtered so a docs-only commit does not rebuild every image. A change under `packages/shared`, the root workspace manifests, that service's `apps/<name>/` directory, or `services/mock-shop/` does rebuild the image that lists that path. The shop image does not list `packages/shared`, because `@mesa/mock-shop` does not import it.
