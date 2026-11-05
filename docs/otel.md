# OpenTelemetry source and import

An agent may register an OTel source. A separate import batch turns a minimal span shape into a lab Trace. The importer does not dial the source, and it does not invent `fault.labels` or `outcome.verifier`.

`CONTRACT_VERSION` `0.4.0` adds optional `Trace.source` (`harness`, `demo_seed`, `otel_prod`, `otel_test`). Documents that omit `source` still validate. `tasks[].evalset` and `Agent.otel` stay optional.

## Source on the agent

`Agent.otel` is stored by the existing `POST /agents` and `PUT /agents/:agent_id`. There is no separate source API. It has dual sources `prod` and `test`. `schema_id` on that object is the lab remap. The shop seed uses `mesa.otel.shop.a` and points at mock-shop. The library seed uses `mesa.otel.library.b` and points at mock-library. Both keep `otel_mock` as a file fallback.

```json
{
  "version": 1,
  "schema_id": "mesa.otel.shop.a",
  "prod": {
    "endpoint": "http://127.0.0.1:8787/internal/otel/traces?source=prod",
    "auth": { "type": "none" },
    "service_name": "reference-shop"
  },
  "test": {
    "endpoint": "http://127.0.0.1:8787/internal/otel/traces?source=test",
    "auth": { "type": "none" },
    "service_name": "reference-shop"
  }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | yes | `1` (`OTEL_SOURCE_VERSION`). |
| `schema_id` | no | Lab remap id. Shop demo A is `mesa.otel.shop.a`. Library demo B is `mesa.otel.library.b`. Not chosen by the mock. |
| `prod.endpoint` / `test.endpoint` | yes | HTTP traces URL for that source. |
| `prod.auth.type` / `test.auth.type` | yes | `none` or `bearer`. |
| `auth.token_env` | bearer only | Env-var name (`^[A-Z_][A-Z0-9_]*$`). Forbidden when `type` is `none`. |
| `service_name` | no | When set, every imported item must send the same `service_name`. |

The lab API has no auth of its own. `token_env` is a name for the operator's collector, not a check the import route performs.

Example: [`packages/shared/examples/otel/source.json`](../packages/shared/examples/otel/source.json).

## Import batch

`POST /agents/:agentId/otel/import` accepts one batch, schema [`packages/shared/schemas/otel-import.schema.json`](../packages/shared/schemas/otel-import.schema.json), `version` `1` (`OTEL_IMPORT_VERSION`). This is not a full OTLP export. Unknown span keys are rejected. At most 20 items.

The mapper is `mapOtelImport` from `@mesa/shared/otel`. That entry loads Ajv. `@mesa/shared` itself does not, so the frontend can still import types from the main entry.

| OTel / batch field | Lab Trace |
| --- | --- |
| `traceId`, or item `trace_id` when set | `trace_id` |
| item `task_id`, `run_id` | `task_id`, `run_id`. Spans do not carry them. `agent_id` is the route agent. |
| span start order | `steps[].index` |
| `spanId` | `step_id` |
| `startTimeUnixNano` | `timestamp` (unix nanoseconds as a decimal string) |
| end minus start | `latency_ms` |
| min start, max end | `started_at`, `ended_at` |
| `attributes["mesa.step.type"]` | `type`: `message`, `tool_call`, `tool_result`, `system` |
| `attributes["mesa.step.role"]` | `role` |
| `attributes["mesa.step.content"]` | `content` for `message` and `system` |
| `attributes["mesa.tool.name"]`, else span `name` | `tool_name` on tool steps |
| `attributes["mesa.tool.input"]`, else JSON `gen_ai.tool.call.arguments` | `tool_input` |
| `attributes["mesa.tool.output"]` | `tool_output` |
| `mesa.step.tokens_in` / `tokens_out`, else `gen_ai.usage.input_tokens` / `output_tokens`, else `0` | `token_usage` |
| `mesa.step.cost_usd`, else `0` | `cost_usd` |
| sum of the step fields | `totals` |
| item `outcome` | `outcome`, copied |
| item `status`, else `completed` when the supplied verifier passed and `failed` otherwise | `status` |

`span.status` is accepted and ignored. It does not set `Trace.status` or `outcome.verifier`.

The mapper always writes:

- `fault`: `{ "injected": false, "labels": [], "attacker": { "used": false, "payload_id": null } }` — the same production mark as [#51](https://github.com/mesagroup/MESA-AgentFailureLab/issues/51). Attribute keys `mesa.fault*`, `mesa.outcome*`, `fault.labels`, and `outcome.verifier` are rejected.
- `diagnosis`: `null`.

`outcome` is required on the item. It must already contain `success` and `verifier.passed`, and those two booleans must be equal. The importer does not fill `checks` or `mock_state_snapshot` from spans, and it does not rewrite either boolean. `status: completed` requires the supplied verifier to have passed. `status: failed` requires it not to have passed. `timeout` and `error` are explicit and leave the verifier as supplied.

Each item also stores a baseline Run: `phase: baseline`, `injection_plan: null`, `fix_kinds: []`, `trace_ids` of the new trace. Run `status` is `passed` only when the trace status is `completed` and the supplied verifier passed; `error` when the trace status is `error`; otherwise `failed`. That run is harness bookkeeping. It is not a ground-truth label.

## HTTP

| Status | Body | When |
| --- | --- | --- |
| 201 | `{ "traces": Trace[], "runs": Run[] }` | Every item mapped, `validateTrace` passed, and the ids were new. |
| 400 | `{ "error": "invalid_otel_import", "message", "errors": string[] }` | Schema, remap, or `validateTrace` failed. Nothing is stored. |
| 404 | `{ "error": "not_found" }` | Unknown agent. |
| 409 | `{ "error": "conflict" }` | A `trace_id` or `run_id` is already stored. Nothing new is stored. |

The route does not take the mock-world gate. It does not call Grok.

Fixture: [`packages/shared/examples/otel/t1-search.import.json`](../packages/shared/examples/otel/t1-search.import.json). One span has `status.code: "ERROR"`. The supplied verifier still passes, and the stored trace keeps that verdict.

## Relation to #51

[#51](https://github.com/mesagroup/MESA-AgentFailureLab/issues/51) is paste or upload of a document that is already a lab Trace. Those fixtures live in [`packages/shared/examples/production/`](../packages/shared/examples/production/README.md). They already carry `outcome.verifier` and the empty `fault.labels` production mark. `validateTrace` is the gate. There is no span mapping.

This import is a separate path for spans that are not a Trace yet. After the mapper runs, the same `validateTrace` gate runs. An operator who already has a lab Trace uses #51 and skips the mapper. An operator who has spans uses this route and must attach an `outcome` the verifier already computed. The mapper will not score the mock.

The Agents page registers `Agent.otel` on create and edit, and posts a pasted or uploaded batch to `POST /agents/:agentId/otel/import`. A successful import opens the stored Trace. The form stores `token_env` only. The bearer token is not sent to the lab. Generating an evalset is `POST /evalset/generate`. Passing an evalset into diagnose stays #119.

## Shop mock remap A

Demo mapping 1 for `reference-shop` is schema A. It is a different document from the generic batch above. `POST /agents/:agentId/otel/import` still accepts only `otel-import.schema.json`.

The demo pull path is HTTP on mock-shop, then `remapShopSchemaA`. The file fallback is `readShopOtelMock` from `otel_mock`.

Schema file: [`packages/shared/schemas/otel-shop-schema-a.schema.json`](../packages/shared/schemas/otel-shop-schema-a.schema.json). Lab `schema_id` is `mesa.otel.shop.a`.

Fixtures, also the mock-shop response bodies:

- [`packages/shared/examples/otel/shop-schema-a/prod-t1-search.json`](../packages/shared/examples/otel/shop-schema-a/prod-t1-search.json)
- [`packages/shared/examples/otel/shop-schema-a/test-t2-cart.json`](../packages/shared/examples/otel/shop-schema-a/test-t2-cart.json)
- [`packages/shared/examples/otel/shop-schema-a/prod-t3-checkout.json`](../packages/shared/examples/otel/shop-schema-a/prod-t3-checkout.json)

The export uses `schema_id`, `shop_export`, and `spans[]` with `shop_trace_id`, `shop_span_id`, `op`, `opened_ms`, `closed_ms`, and `shop_attrs`. Attribute keys use the `shop.` prefix. Times are unix milliseconds. This is not OTLP protobuf. `mapOtelImport` rejects this document.

`remapShopSchemaA` copies `shop_export.verdict` onto `outcome`, writes the production fault mark, and runs `validateTrace`. It does not invent `fault.labels` or `outcome.verifier`. A `schema_id` other than `mesa.otel.shop.a` fails with `schema_id <id> is not mesa.otel.shop.a`.

### Fake APM on mock-shop

`GET /internal/otel/traces` on `services/mock-shop` (port `8787`, origin `MOCK_SHOP_URL`).

| Query | Required | Meaning |
| --- | --- | --- |
| `source` | no | `prod` or `test`. Default `prod`. |
| `since` | no | ISO-8601 date-time. Keep spans with `opened_ms` greater than or equal to that instant. Omit it to return the entire seed. |

A bad `source` or `since` is `400` `{ "error": "invalid_request" }`. The route is read-only. It does not change carts, orders, or inventory. The response may include header `X-Mock-Otel-Schema: mesa.otel.shop.a` as a hint. The lab remap still reads `schema_id` from the agent.

Laptop URLs:

- `http://127.0.0.1:8787/internal/otel/traces?source=prod`
- `http://127.0.0.1:8787/internal/otel/traces?source=test`

`bindSeedAgent` rewrites those hosts from `MOCK_SHOP_URL` together with `world.base_url`.

`pullShopOtelMock` GETs `Agent.otel.prod` or `Agent.otel.test`. `readShopOtelMock` still reads `otel_mock.sources[].fixture_path` and does not open a socket.

## Library mock remap B

Demo mapping 2 for `external-library` is schema B. It is a different document from the generic batch above and from shop mapping A. `POST /agents/:agentId/otel/import` still accepts only `otel-import.schema.json`. Schema B is loaded with `readLibraryOtelMock` then `remapLibrarySchemaB`, or pulled over HTTP from mock-library and then remapped.

Schema file: [`packages/shared/schemas/otel-library-schema-b.schema.json`](../packages/shared/schemas/otel-library-schema-b.schema.json). The export uses `schema_hint` `mesa.otel.library.b`. The lab agent stores `schema_id` `mesa.otel.library.b`. The mock does not store `schema_id`.

Fixtures, also the mock-library response bodies:

- [`packages/shared/examples/otel/library-schema-b/prod-renew-loan.json`](../packages/shared/examples/otel/library-schema-b/prod-renew-loan.json)
- [`packages/shared/examples/otel/library-schema-b/test-return-loan.json`](../packages/shared/examples/otel/library-schema-b/test-return-loan.json)
- [`packages/shared/examples/otel/library-schema-b/prod-place-hold.json`](../packages/shared/examples/otel/library-schema-b/prod-place-hold.json)

The export uses `library_export` and `spans[]` with `lib_trace_id`, `lib_span_id`, `action`, `started_at`, `ended_at` (ISO-8601), and `lib_attrs`. Attribute keys use the `lib.` prefix. `mapOtelImport` rejects this document. A shop A `schema_hint` fails with `schema_hint mesa.otel.shop.a is not mesa.otel.library.b`.

`remapLibrarySchemaB` copies `library_export.verdict` onto `outcome`, writes the production fault mark, and runs `validateTrace`. It does not invent `fault.labels` or `outcome.verifier`.

| | Shop A (#155 / #161) | Library B (#156) |
| --- | --- | --- |
| Lab `schema_id` | `mesa.otel.shop.a` | `mesa.otel.library.b` |
| Export id | `schema_id` | `schema_hint` |
| Root | `shop_export` | `library_export` |
| Span ids | `shop_trace_id`, `shop_span_id` | `lib_trace_id`, `lib_span_id` |
| Times | `opened_ms`, `closed_ms` (unix ms) | `started_at`, `ended_at` (ISO-8601) |
| Attributes | `shop.*` | `lib.*` |
| Remap | `remapShopSchemaA` | `remapLibrarySchemaB` |
| HTTP | `services/mock-shop` `GET /internal/otel/traces` | `services/mock-library` `GET /internal/otel/traces` |

### Fake APM on mock-library

`GET /internal/otel/traces` on `services/mock-library` (port `8788`, origin `MOCK_LIBRARY_URL`).

| Query | Required | Meaning |
| --- | --- | --- |
| `source` | no | `prod` or `test`. Default `prod`. |
| `since` | no | ISO-8601 date-time. Keep spans with `started_at` greater than or equal to that instant. Omit it to return the entire seed. |

Unknown query keys, a bad `source`, or a bad `since` are `400` `{ "error": "invalid_request" }`. Optional header `X-Mock-Otel-Schema`: omit it, or send `mesa.otel.library.b`. Any other value is 400. The route is read-only. It does not seed, renew, return, or reset the desk.

Laptop URLs:

- `http://127.0.0.1:8788/internal/otel/traces?source=prod`
- `http://127.0.0.1:8788/internal/otel/traces?source=test`

`bindSeedAgent` rewrites those hosts from `MOCK_LIBRARY_URL` together with `world.base_url`.

## Pull traces

`POST /agents/:agentId/traces/pull` reads `Agent.otel.prod` and `Agent.otel.test`, remaps the body, runs `validateTrace`, and upserts Trace and its baseline Run. This is the Refresh action. It does not take the mock-world gate and it does not call Grok.

The route does not invent `outcome.verifier` or `fault.labels` ([ADR-001](../adr/001-mock-verifier-grok.md)). Shop schema A uses `remapShopSchemaA`. Library schema B uses `remapLibrarySchemaB`. Both copy the export `verdict` onto `outcome` and write the production fault mark (`injected: false`, `labels: []`). `diagnosis` stays null. A stored trace that already has injector or attacker labels is left in place and reported as `conflict`. An existing `diagnosis` is kept when the incoming trace has `diagnosis: null`.

`otel.schema_id` selects the remap: `mesa.otel.shop.a` or `mesa.otel.library.b`. The mock response header is not the selector.

### Request

`agentId` is the same path parameter as the other agent routes.

```json
{ "sources": ["prod", "test"], "since": "2026-11-01T00:00:00.000Z" }
```

| Field | Required | Meaning |
| --- | --- | --- |
| `sources` | no | `prod`, `test`, or both. Default both. Duplicates are rejected. |
| `since` | no | Inclusive ISO-8601 lower bound for this call. Overrides the stored cursor for this call only. |

An empty object `{}` pulls both sources. Unknown fields, a bad `since`, or a `since` after the server clock are HTTP 400 `invalid_request`.

### Window and `last_pull_at`

The cursor is per agent and per source. It is not a field on Agent or Trace. Postgres stores it in `otel_pull_cursors`. Memory keeps it on the run store. `db:reset` deletes the cursors with the runs and traces.

| Situation | `since` sent to the endpoint |
| --- | --- |
| Body includes `since` | That instant. |
| No body `since`, and this source has `last_pull_at` | The stored cursor. |
| No body `since`, and this source has never pulled successfully | `since` is omitted. The mock returns its whole seed. |

The first pull omits `since` on purpose. The shop demo spans are `2026-11-03T14:12:08.014Z`, which is before `reference-shop` `created_at` (`2026-11-04T09:00:00.000Z`) and outside a rolling 24 hours on a later clock. Sending either of those as the first lower bound would drop the demo spans and look like an empty pull. A later pull sends `last_pull_at`, which is the server time at the start of the last successful pull, so only spans at or after that instant come back.

A successful source, including one that returns no spans, stores `last_pull_at`. Auth, network, remap, validation, and conflict failures do not move that source's cursor.

`GET /agents/:agentId/otel/cursors` returns the stored cursors and does not fetch:

```json
{
  "agent_id": "reference-shop",
  "prod": { "tag": "otel_prod", "last_pull_at": "2026-11-05T08:40:00.000Z" },
  "test": { "tag": "otel_test", "last_pull_at": null }
}
```

### Fetch

The lab GETs `otel.prod.endpoint` or `otel.test.endpoint` and adds `since` when the window has a lower bound. The seeded URLs already include `source=prod` or `source=test`. Redirects are not followed. The call waits at most 10 seconds.

`auth.type: bearer` reads `process.env[auth.token_env]` and sends `Authorization: Bearer …`. A missing or blank env var is an `auth` error and does not call the endpoint. The token is not written onto the agent. `auth.type: none` sends no credential.

`otel_mock.mode: fixture` is a dev fallback. It runs only when the TCP connection fails (refused, timeout, DNS) and `otel_mock.schema_id` matches `otel.schema_id`. The response then says `transport: "fixture"` and includes the HTTP error in `message`. HTTP 4xx and 5xx, auth failures, and a body that fails remap do not fall back. The primary demo path is the mock HTTP route above.

### Response

HTTP 200 even when a source fails. Counts are the sum across sources. `errors` repeats each source error so the client does not have to walk `sources` to find a failure. An empty window is `empty: true` and `failed: 0`, with `message` saying there were no spans. It is not an error and it is not a silent `[]`.

```json
{
  "agent_id": "reference-shop",
  "imported": 1,
  "skipped": 1,
  "failed": 0,
  "sources": [
    {
      "source": "prod",
      "tag": "otel_prod",
      "transport": "http",
      "since": null,
      "until": "2026-11-05T08:40:00.000Z",
      "previous_last_pull_at": null,
      "last_pull_at": "2026-11-05T08:40:00.000Z",
      "imported": 1,
      "skipped": 0,
      "failed": 0,
      "empty": false,
      "message": "Imported 1 trace.",
      "trace_ids": ["shop-a-prod-t1"],
      "errors": []
    }
  ],
  "errors": []
}
```

| Field | Meaning |
| --- | --- |
| `imported` | Inserted, or replaced because the mapped document differed. A demo seed row pulled again is updated in place and tagged `otel_prod` or `otel_test`. |
| `skipped` | The same trace id was already stored and the mapped document was unchanged. No second row. |
| `failed` | Remap, validation, auth, network, or conflict. Nothing from that item was written. |
| `errors[].kind` | `network`, `auth`, `remap`, `validation`, or `conflict`. |
| `transport` | `http`, `fixture`, or `none` when the source failed before a body was read. |

| Status | Body | When |
| --- | --- | --- |
| 200 | The object above | The body was accepted. Check `failed` and `errors`. |
| 400 | `{ "error": "invalid_request", "message" }` | Bad `sources` or `since`. |
| 400 | `{ "error": "otel_not_configured", "message" }` | The agent has no `otel` object. |
| 404 | `{ "error": "not_found", "message" }` | Unknown agent. |

The mock HTTP routes serve one export per source. Shop pull imports prod T1 (`shop-a-prod-t1`) and test T2 (`shop-a-test-t2`). Library pull imports renew (`lib-b-prod-renew`) and return (`lib-b-test-return`). The extra demo files (shop T3, library place-hold) stay `demo_seed` until a later export serves them. Re-pull does not insert a second copy of an id.

### List

`GET /traces` stays `{ "traces": Trace[] }`, oldest first. Optional filters:

| Query | Meaning |
| --- | --- |
| `agent_id` | Exact `Trace.agent_id`. |
| `source` | `harness`, `demo_seed`, `otel_prod`, or `otel_test`. |
| `since` | Inclusive lower bound on `started_at` (ISO-8601). |
| `until` | Inclusive upper bound on `started_at`. |

A bad `source`, `since`, or `until` is HTTP 400 `invalid_request`.

`Trace.source` is set by the writer: the harness and the attacker write `harness`, startup demo pairs write `demo_seed`, and this pull writes `otel_prod` or `otel_test`. `POST /agents/:agentId/otel/import` does not set `source`. A document that omits `source` still validates. The list filter treats that omission as `harness`, except a known demo seed trace id, which it treats as `demo_seed`. The stored JSON is not rewritten to add the field.

```bash
curl -s -X POST http://127.0.0.1:3001/agents/reference-shop/traces/pull \
  -H 'content-type: application/json' \
  -d '{}'
curl -s 'http://127.0.0.1:3001/traces?agent_id=reference-shop&source=otel_prod'
curl -s http://127.0.0.1:3001/agents/reference-shop/otel/cursors
```

Frontend Refresh should POST this route, show `imported`, `skipped`, `failed`, and `errors[].message`, then reload `GET /traces` with the agent and source filters. The button does not belong to this change.
