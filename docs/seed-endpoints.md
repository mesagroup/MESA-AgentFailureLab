# Seed endpoints

`reference-shop` and `external-library` are real agents. On boot the backend copies each fixture and writes the runtime and mock origins for this process onto the row. The harness calls `POST {runtime}/v1/tasks/run`. It does not store that path on the agent. The origin is `instance.base_url` for `baseline` and `test_instance.base_url` for `injected` and `after_fix`. Both seeds set those two fields to the same origin.

The fixture files keep the laptop defaults so the JSON is a valid agent without a process environment:

- [`packages/shared/examples/agent-reference-shop.json`](../packages/shared/examples/agent-reference-shop.json)
- [`packages/shared/examples/agent-library-desk.json`](../packages/shared/examples/agent-library-desk.json)

`apps/backend/src/agents/endpoints.ts` replaces the origins when it builds the seed. A variable that is set wins. A blank or missing variable uses the default for that environment.

| Variable | Seed field | What the harness calls |
| --- | --- | --- |
| `AGENTSERVICE_URL` | `reference-shop` `instance.base_url` and `test_instance.base_url` | `POST {origin}/v1/tasks/run` on `mesa-agentservice` |
| `MOCK_SHOP_URL` | `reference-shop` `world.base_url` (`kind: shop`) and `otel.prod` plus `otel.test` endpoints | Shop tool routes, `GET /internal/state`, and `GET /internal/otel/traces` with `source=prod` or `source=test`. A shop run uses the process value of `MOCK_SHOP_URL`, which is this same variable. A test may pass another shop URL without editing the row. |
| `LIBRARY_AGENT_URL` | `external-library` `instance.base_url` and `test_instance.base_url` | `POST {origin}/v1/tasks/run` on `mesa-library-agent` |
| `MOCK_LIBRARY_URL` | `external-library` `world.base_url` (`kind: library`) | Library `POST /internal/seed` and tool routes. A library run uses the URL stored on the row. |

`mesa-agentservice` does not read a shop URL. The harness sends `mock_base_url` on `POST /v1/tasks/run`.

## URLs per environment

| Variable | `pnpm dev` (unset) | Docker Compose | Render (`NODE_ENV=production`) |
| --- | --- | --- | --- |
| `AGENTSERVICE_URL` | `http://127.0.0.1:3002` | `http://mesa-agentservice:3002` | `https://mesa-agentservice.onrender.com` |
| `MOCK_SHOP_URL` | `http://127.0.0.1:8787` | `http://mesa-mock-shop:8787` | `https://mesa-mock-shop.onrender.com` |
| `LIBRARY_AGENT_URL` | `http://127.0.0.1:3003` | `http://mesa-library-agent:3003` | `https://mesa-library-agent.onrender.com` |
| `MOCK_LIBRARY_URL` | `http://127.0.0.1:8788` | `http://mesa-mock-library:8788` | `https://mesa-mock-library.onrender.com` |

`pnpm dev` binds the laptop defaults above when the variable is unset. Copy [`apps/backend/.env.example`](../apps/backend/.env.example) to `apps/backend/.env` to override them. `pnpm dev` and `pnpm start` in `@mesa/backend` load that file when it exists. Start the shop with `pnpm dev:mock-shop`. Start the library pair with `pnpm --filter @mesa/mock-library dev` and `pnpm --filter @mesa/library-agent dev`.

Compose sets the four DNS names on `mesa-backend`. The backend image also sets `NODE_ENV=production`. The Compose values are set, so they win over the public Render defaults. A bare `docker run` of that image, with none of the four variables set, seeds the public Render origins. That is what the image health check does. It does not call those hosts.

On Render, `render.yaml` sets the four variables on `mesa-backend` to the public `https://` origins. `NODE_ENV=production` refuses a loopback value (`localhost`, `127.0.0.1`, or `::1`) and the process exits instead of storing it. When a variable is missing in production, the fallback is the intended public host in the table, never a loopback address. Those fallbacks live in `PRODUCTION_SEED_URLS` and match `render.yaml`. A test reads both and fails if they diverge.

`POST /runs` with no `driver` uses `auto` for every registered agent, including `reference-shop`. The lab UI does not send a driver. `auto` probes `{base}/health` and, when that answers, calls `POST {base}/v1/tasks/run`. Baseline uses `instance.base_url`. Injected and after_fix use `test_instance.base_url`. A probe that fails uses the scripted sequence, so a down runtime still returns a trace. An explicit `driver: scripted` does not call the runtime. `pnpm generate-dataset` passes `driver: scripted`. `pnpm eval:gate` scores the frozen dataset and does not take this default.

## When a stored row changes

The fixtures' `updated_at` values are unchanged by a URL overlay. Boot still follows the seed rules:

| Stored row | Boot |
| --- | --- |
| Id missing | Insert the fixture with this process's URLs |
| Document fails the Agent schema | Rewrite from the fixture |
| `updated_at` earlier than the fixture | Rewrite from the fixture |
| `updated_at` equal to the fixture, and the runtime or world URL differs | Rewrite from the fixture, including the URLs for this process |
| `updated_at` newer than the fixture | Keep the row, including a name or URL changed with PUT |

An edit in the Agents page is a PUT. That sets `updated_at` to the time of the save, which is newer than the fixture, so the next boot keeps it. Change the URL in that form when a host changes and the row was already edited. An unedited seed picks up a new environment on the next boot because its timestamp still matches the fixture and the origins differ.

`DELETE` of either id stays 409. `db:reset` still keeps both rows and uses the same rewrite rules.

## Render

`AGENTSERVICE_URL` and `MOCK_SHOP_URL` were already on `mesa-backend`. This change adds `LIBRARY_AGENT_URL` and `MOCK_LIBRARY_URL` in `render.yaml`. A Blueprint sync writes them. Auto-sync off means the merge does not set them until someone runs Manual Sync. Until that sync, a production boot with the variables missing uses the public hosts in the table above, which are the same intended values.

If Render assigns a suffix, put the assigned `https://…onrender.com` origin in `render.yaml` and in `PRODUCTION_SEED_URLS` (`apps/backend/src/agents/endpoints.ts`) before the next sync. The Dashboard and the file have to name the same host. A sync overwrites a Dashboard-only edit of a variable this file declares. Then restart `mesa-backend`. These four variables are read at process start. The frontend image does not bake them.

Confirm after the sync:

```bash
curl -fsS https://mesa-backend-itm4.onrender.com/health
curl -fsS https://mesa-agentservice.onrender.com/health
curl -fsS https://mesa-mock-shop.onrender.com/health
curl -fsS https://mesa-library-agent.onrender.com/health
curl -fsS https://mesa-mock-library.onrender.com/health
```

`GET /health` on the backend reports `mock_base_url`. That is `MOCK_SHOP_URL`. It does not call the shop. `GET /agents/reference-shop` and `GET /agents/external-library` show the origins stored for that process.
