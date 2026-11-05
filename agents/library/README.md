# Library desk (`external-library`)

External agent for issue #109. It is not the shop. It renews a loan, accepts a return, and places a hold when the only copy is already out.

| Piece | Where |
| --- | --- |
| Agent record | `packages/shared/examples/agent-library-desk.json` |
| Runtime | `apps/library-agent` — `GET /health`, `POST /v1/tasks/run` |
| World | `services/mock-library` — `GET /internal/state`, `GET /internal/otel/traces` |
| OTel mapping B | `packages/shared/schemas/otel-library-schema-b.schema.json` (`mesa.otel.library.b`) |
| Checks | `loan_renewed`, `loan_returned`, `hold_placed` |

`instance.kind` is `external`. `instance.base_url` is the runtime, not the mock. `world.base_url` is the mock.

The fixture file shows the laptop origins (`http://127.0.0.1:3003` and `http://127.0.0.1:8788`). The backend replaces them at seed time. Compose uses `http://mesa-library-agent:3003` and `http://mesa-mock-library:8788`. Render uses the public hosts below. `NODE_ENV=production` does not store a loopback origin. See [docs/seed-endpoints.md](../../docs/seed-endpoints.md).

Public hosts the blueprint asks Render to assign:

- runtime: `https://mesa-library-agent.onrender.com` (`LIBRARY_AGENT_URL`)
- mock: `https://mesa-mock-library.onrender.com` (`MOCK_LIBRARY_URL`)

If Render appends a suffix, change `render.yaml` and `PRODUCTION_SEED_URLS` together, then redeploy `mesa-backend`. Do not put the loopback address in the production environment.

## Run locally

From the repo root, in two terminals:

```bash
pnpm --filter @mesa/mock-library dev
pnpm --filter @mesa/library-agent dev
```

The mock listens on `127.0.0.1:8788`. The runtime listens on `127.0.0.1:3003`. Fake APM: `GET http://127.0.0.1:8788/internal/otel/traces?source=prod` (or `source=test`). Query `since` is optional ISO-8601. Optional header `X-Mock-Otel-Schema: mesa.otel.library.b`. A laptop boot of the backend, with the variables unset, seeds those same origins. A deployed boot seeds the public hosts from `LIBRARY_AGENT_URL` and `MOCK_LIBRARY_URL`.

Compose service names, when you want the stack instead of the laptop ports:

- `http://mesa-library-agent:3003`
- `http://mesa-mock-library:8788`

## Register on the lab

The backend seeds `external-library` on boot and writes `LIBRARY_AGENT_URL` and `MOCK_LIBRARY_URL` onto that row. The JSON file itself still shows the laptop origins, so posting that file at the deployed lab would register loopback until the next boot rewrites a row that is not newer than the fixture. If the id is already seeded, `POST` returns 409. Edit it with `PUT /agents/external-library`. The Agents page uses that same PUT. A valid edit newer than the fixture is not overwritten on the next boot.

## Launch the three tasks

`POST /runs` with no `driver` uses `auto` for `kind: external`, so baseline calls `instance.base_url`. The harness copies `world.base_url` into `mock_base_url`, seeds `setup.library.loans`, executes the actions, and writes `outcome.verifier`.

```bash
curl -sS -X POST https://mesa-backend-itm4.onrender.com/runs \
  -H 'content-type: application/json' \
  -d '{"agent_id":"external-library","phase":"baseline"}'
```

Omit `task_ids` to run `renew-loan`, `return-loan`, and `place-hold`. Each result has a trace whose `outcome.verifier.passed` is the verdict. The trace does not carry `phase` or `fix_kinds`.

## Demo inject (#189)

Doc for presenters (issue #189). No runtime importer.

Hero reliability for the live ~90s cut: `renew-loan` with preset `forged_tool_result` (target `renew_loan`). The tool result shows `renewals: 1`; the mock stays at `0`; the verifier fails `loan_renewed` while the agent still claims success.

```bash
curl -sS -X POST http://127.0.0.1:3001/runs \
  -H 'content-type: application/json' \
  -d '{"agent_id":"external-library","phase":"injected","task_ids":["renew-loan"]}'
```

Seeded storyboard pair (boot insert-if-absent): `run-renew-injected-001` / `trace-renew-forged-loan` with canned `diagnosis.proposed_fixes: ["pre_response_check"]`.

`after_fix` with `fix_kinds: ["pre_response_check"]` needs the HTTP library-agent up: the planner appends a second `renew_loan` after the confirming `get_loan` (same idea as shop T3's second checkout). Scripted driver ignores `fix_kinds`.
