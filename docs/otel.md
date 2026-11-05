# OpenTelemetry source and import

An agent may register an OTel source. A separate import batch turns a minimal span shape into a lab Trace. The importer does not dial the source, and it does not invent `fault.labels` or `outcome.verifier`.

`CONTRACT_VERSION` `0.3.0` carries this field together with `tasks[].evalset`. Both are optional. Clients that omit them still validate.

## Source on the agent

`Agent.otel` is stored by the existing `POST /agents` and `PUT /agents/:agent_id`. There is no separate source API. The shop and library seeds omit it.

```json
{
  "version": 1,
  "endpoint": "https://otel.example.com/v1/traces",
  "auth": { "type": "bearer", "token_env": "OTEL_SOURCE_TOKEN" },
  "service_name": "reference-shop"
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | yes | `1` (`OTEL_SOURCE_VERSION`). |
| `endpoint` | yes | OTLP HTTP traces URL the operator documents. The importer does not call it. |
| `auth.type` | yes | `none` or `bearer`. |
| `auth.token_env` | bearer only | Env-var name (`^[A-Z_][A-Z0-9_]*$`). The token is not stored on the agent. Forbidden when `type` is `none`. |
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
