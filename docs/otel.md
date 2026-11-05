# OpenTelemetry source and import

An agent may register an OTel source. A separate import batch turns a minimal span shape into a lab Trace. The importer does not dial the source, and it does not invent `fault.labels` or `outcome.verifier`.

`CONTRACT_VERSION` `0.3.0` carries this field together with `tasks[].evalset`. Both are optional. Clients that omit them still validate.

## Source on the agent

`Agent.otel` is stored by the existing `POST /agents` and `PUT /agents/:agent_id`. There is no separate source API. It has dual sources `prod` and `test`. `schema_id` on that object is the lab remap. The library seed omits `otel`. The shop seed sets both HTTP sources and a fixture fallback in `otel_mock`.

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
| `schema_id` | no | Lab remap id. Shop demo A is `mesa.otel.shop.a`. Not chosen by the mock. |
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

Library mapping B is reserved and is not in this package. Its `schema_id` is `mesa.otel.library.b`. Its root key is `library_export`. Its attribute prefix is `lib.`. Its span id field is `lib_span_id`. The HTTP path on the library mock is the same `/internal/otel/traces`. Issue #156 owns those files. Issue #154 owns a later lab traces pull route.
