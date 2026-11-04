# Library desk (`external-library`)

External agent for issue #109. It is not the shop. It renews a loan, accepts a return, and places a hold when the only copy is already out.

| Piece | Where |
| --- | --- |
| Agent record | `packages/shared/examples/agent-library-desk.json` |
| Runtime | `apps/library-agent` — `GET /health`, `POST /v1/tasks/run` |
| World | `services/mock-library` — `GET /internal/state` |
| Checks | `loan_renewed`, `loan_returned`, `hold_placed` |

`instance.kind` is `external`. `instance.base_url` is the runtime, not the mock. `world.base_url` is the mock.

Public hosts the blueprint asks Render to assign:

- runtime: `https://mesa-library-agent.onrender.com`
- mock: `https://mesa-mock-library.onrender.com`

Neither URL is `localhost` or `127.0.0.1`. If Render appends a suffix, change the fixture and `render.yaml` together, then redeploy.

## Run locally

From the repo root, in two terminals:

```bash
pnpm --filter @mesa/mock-library dev
pnpm --filter @mesa/library-agent dev
```

The mock listens on `127.0.0.1:8788`. The runtime listens on `127.0.0.1:3003`. Those loopback addresses are for a laptop only. The seeded document keeps the public hosts so a boot of the deployed lab does not register loopback.

Compose service names, when you want the stack instead of the laptop ports:

- `http://mesa-library-agent:3003`
- `http://mesa-mock-library:8788`

## Register on the lab

The backend seeds `external-library` on boot. To register the same document by hand against the deployed lab:

```bash
curl -sS -X POST https://mesa-backend-itm4.onrender.com/agents \
  -H 'content-type: application/json' \
  -d @packages/shared/examples/agent-library-desk.json
```

If the id is already seeded, `POST` returns 409. Edit it with `PUT /agents/external-library`. The Agents page uses that same PUT. A valid edit is not overwritten on the next boot.

## Launch the three tasks

`POST /runs` with no `driver` uses `auto` for `kind: external`, so baseline calls `instance.base_url`. The harness copies `world.base_url` into `mock_base_url`, seeds `setup.library.loans`, executes the actions, and writes `outcome.verifier`.

```bash
curl -sS -X POST https://mesa-backend-itm4.onrender.com/runs \
  -H 'content-type: application/json' \
  -d '{"agent_id":"external-library","phase":"baseline"}'
```

Omit `task_ids` to run `renew-loan`, `return-loan`, and `place-hold`. Each result has a trace whose `outcome.verifier.passed` is the verdict. The trace does not carry `phase` or `fix_kinds`.
