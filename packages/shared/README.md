# @mesa/shared

JSON Schema is the source of truth for **Trace**, **Agent**, and **Run**. TypeScript in `src/types.ts` is a hand-written mirror. Do not treat OpenAPI as the source of truth.

| Document | Schema | What it is |
| --- | --- | --- |
| Trace | [`schemas/trace.schema.json`](schemas/trace.schema.json) | One observed attempt: steps, timings, costs, verifier outcome, fault labels, optional diagnosis |
| Agent | [`schemas/agent.schema.json`](schemas/agent.schema.json) | Registration: instance, test instance, trace location, docs, tasks |
| Run | [`schemas/run.schema.json`](schemas/run.schema.json) | Harness record: phase, injection plan, fix kinds, links to trace ids |

Package exports:

- `@mesa/shared` — `CONTRACT_VERSION` (`0.3.0`), `TASK_EVALSET_VERSION` (`1`), `OTEL_SOURCE_VERSION` (`1`), `OTEL_IMPORT_VERSION` (`1`), `GROK_FORBIDDEN_WRITE_PATHS`, and the TypeScript types, including `AgentRunRequest`, `TaskEvalset`, `TaskEvalCase`, and `OtelSourceConfig`. This entry does not load Ajv, so the frontend can import it. It also exports the check registry (`CHECK_TYPES`, `CHECK_REGISTRY`) and `planShopTask`.
- `@mesa/shared/otel` — `mapOtelImport`. This entry loads Ajv. It maps an OTel import batch onto Traces and validates each one with `validateTrace`.
- `@mesa/shared/validate` — Ajv validators (`validateTrace`, `validateAgent`, `validateRun`) and the loaded schema objects.
- `@mesa/shared/schemas/trace.schema.json` (and `agent`, `run`).
- `@mesa/shared/examples/agent-reference-shop.json` — the reference shop agent (T1–T5). The harness loads this; it is not a second schema. Seed URLs are applied by the backend ([docs/seed-endpoints.md](../../docs/seed-endpoints.md)).
- `@mesa/shared/examples/agent-library-desk.json` — the library desk fixture (`external-library`, three loan tasks). Seeded the same way as the reference shop. `instance.kind` is `external`.

When a contract field changes: edit the JSON Schema, update `src/types.ts` in the same change, bump `CONTRACT_VERSION`, and run `pnpm --filter @mesa/shared test`.

## Agent run request

`AgentRunRequest` is the body of `POST /v1/tasks/run`. It is a TypeScript type in `src/types.ts`, not a fourth JSON Schema. Trace, Agent, and Run stay the schema documents.

| Field | Required | Notes |
| --- | --- | --- |
| `agent_id`, `task_id`, `task`, `prompt`, `session_id`, `permissions`, `mock_base_url` | yes | `task` is the full `AgentTask`. The reference agent plans from it. `prompt` is the text it sees and may include an attached note after `task.prompt` |
| `order_id` | no | Present when `task.setup.orders` created an order |
| `fix_kinds` | no | `controlled_retry`, `pre_response_check`, `permission_guard`. Omit it, or send `[]`, when the run applies no fix. The reference agent reads this field and passes it to `applyFixesToPlan` when the plan is the canonical lab plan |

The reference agent does not write `outcome.verifier` or `fault.*`. A task it cannot plan is refused. The format of `task` is in [docs/agent-tasks.md](../../docs/agent-tasks.md).

## Run is not a Trace

`phase`, `injection_plan`, and `fix_kinds` live on the **Run**. Copying them onto a Trace fails the schema.

| | Run | Trace |
| --- | --- | --- |
| `phase` | `baseline` \| `injected` \| `after_fix` | absent |
| `injection_plan` | fault, target, optional `at_step`, `ground_truth` | absent. The injector writes the resulting labels onto `fault.labels` |
| `fix_kinds` | `controlled_retry` \| `pre_response_check` \| `permission_guard` | absent. A diagnosis may only propose these values |
| `trace_ids` | traces this run produced or compares | the trace has its own `trace_id` and points back with `run_id` |
| `parent_run_id` | optional link to the run being replayed | absent |
| `error_message`, `duration_ms` | optional harness fields | absent. Step and total timings live on the trace |

Phase rules:

- `baseline`: `injection_plan` is null and `fix_kinds` is empty.
- `injected`: `injection_plan` is an object and `fix_kinds` is empty.
- `after_fix`: `fix_kinds` has at least one entry. `injection_plan` may repeat the original fault or be null for a clean replay.

## Who writes which Trace field

`GROK_FORBIDDEN_WRITE_PATHS` lists the paths the agent service must not write: `outcome.verifier`, `fault.injected`, `fault.labels`, `fault.attacker`.

- `outcome.verifier` is the only pass/fail authority. The deterministic verifier computes it from mock state. `outcome.success` must equal `outcome.verifier.passed`. The agent and Grok do not write this object. `tasks[].evalset` is not a Trace field and is not an input to that computation.
- `outcome.agent_claimed_success` is what the agent asserted. It is not a verdict.
- `fault.labels` are written only by the injector or the attacker. A clean attempt has `injected: false`, no labels, and `attacker.used: false` with `payload_id: null`.
- `diagnosis` stays `null` until Grok runs. Fault labels and the diagnosis category need not match.
- Every step requires `latency_ms`, `token_usage` (`input`, `output`), and `cost_usd`. `totals` is required too.

`diagnosis.step_id` is the culprit step. `diagnosis.proposed_fixes` uses the same `FixKind` values the Run stores in `fix_kinds` once a fix is applied.

Trace `status`: `completed` when the attempt finished and the verifier passed; `failed` when it finished and the verifier did not; `timeout` when the harness hit a time limit; `error` when a runtime or harness error stopped the attempt.

## Step shape

Always required: `step_id`, `index`, `type`, `timestamp`, `role`, `latency_ms`, `token_usage`, `cost_usd`.

| `type` | Also required | `role` |
| --- | --- | --- |
| `message` | `content` | `user` or `assistant` |
| `tool_call` | `tool_name`, `tool_input` | `assistant` |
| `tool_result` | `tool_name`, `tool_output` | `tool` |
| `system` | `content` | `system` |

## Agent

`instance.kind` is `reference` or `external`. `instance.base_url` is the agent runtime, not the mock shop. `tasks[].success_test.type` is `verifier_checks`. Each task has `setup` (cart, orders, granted permissions) and check `params` constrained by the check registry. The reference shop agent registers T1–T5 as that data. The shop that produces `mock_state_snapshot` is [`services/mock-shop`](../../services/mock-shop). Hand-written traces for T2, T3, and T5 use the harness fault codes and live in this package's `examples/` directory. The harness loads the reference shop agent and executes tool calls itself.

### Task evalset

`tasks[].evalset` is optional user data. A later Grok judgment of that task's Run or Trace may read it. It is not a verifier check, and it does not write `outcome.verifier`. Pass/fail stays on `success_test.checks`, which the deterministic verifier scores from mock world state ([ADR-001](../../adr/001-mock-verifier-grok.md)). This package does not call Grok. `validateTaskEvalset` in `@mesa/shared/validate` is the same shape used by `POST /evalset/generate`.

`TASK_EVALSET_VERSION` is `1`. That is the only valid `evalset.version`. Omit `evalset` when the task has none. `version: 1` with `cases: []` is also valid. `rubric` is optional on a case. `case_id` is unique within the task.

T1 of [`examples/agent-reference-shop.json`](examples/agent-reference-shop.json) is the seed example. T2–T5 and the library desk tasks omit the field.

```json
{
  "version": 1,
  "cases": [
    {
      "case_id": "claim-after-catalog",
      "expectation": "The assistant claims it opened the ceramic mug only after a catalog search and a product read.",
      "rubric": "Cite the claim step and the tool steps. Do not score cart or order state; that is outcome.verifier."
    }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | yes, when `evalset` is present | Shape of this object. Only `1`. |
| `cases` | yes, when `evalset` is present | Author order. May be empty. |
| `cases[].case_id` | yes | Stable id inside this task. |
| `cases[].expectation` | yes | What the judge should look for in the Trace or Run. Not a world-state assertion. |
| `cases[].rubric` | no | How to score the expectation. Free text. |

`POST /agents` and `PUT /agents/:agent_id` store the field with the rest of the task. Clients that omit it still validate. Proposing cases is `POST /evalset/generate` (agentservice, proxied by the backend). That route does not persist the Agent. `validateTaskEvalset` in `@mesa/shared/validate` checks a standalone object of that shape (including duplicate `case_id` values). The backend diagnose path may send it next to a Trace; it is still not a Trace field. `CONTRACT_VERSION` stays `0.3.0` for this HTTP envelope.

### OTel source

`otel` on the agent is optional. It names an OpenTelemetry endpoint, an auth mode (`none` or `bearer` plus `token_env`), and an optional `service_name`. The token is not stored. The shop and library seeds omit the object. The import batch and the field mapping are in [docs/otel.md](../../docs/otel.md). The mapper does not invent `fault.labels` or `outcome.verifier`. Production paste/upload of an already valid Trace stays [#51](https://github.com/mesagroup/MESA-AgentFailureLab/issues/51).

## Examples

- [`examples/injected-failed-trace.json`](examples/injected-failed-trace.json) — T3, forged checkout result, verifier failed, diagnosis present.
- [`examples/t2-wrong-argument.json`](examples/t2-wrong-argument.json) — T2, catalog code `wrong_argument`.
- [`examples/t3-suppressed-readback.json`](examples/t3-suppressed-readback.json) — T3, catalog code `suppressed_readback`.
- [`examples/t5-forged-permission-success.json`](examples/t5-forged-permission-success.json) — T5, catalog code `forged_permission_success`.
- [`examples/timeout-repeated-tool-trace.json`](examples/timeout-repeated-tool-trace.json) — harness timeout plus two identical `search_products` calls. `diagnosis` is null.
- [`examples/tool-error-trace.json`](examples/tool-error-trace.json) — checkout tool result with `status: "error"`. `diagnosis` is null.
- [`examples/agent-reference-shop.json`](examples/agent-reference-shop.json) — reference shop agent with T1–T5.
- [`examples/run-injected.json`](examples/run-injected.json) — the Run that owns that trace (`phase: injected`).
- [`examples/production/`](examples/production/) — three clean production exports (T1, T3, T5) for the import screen. No fault labels. `diagnosis` is null. Usage notes are in that folder's README.

`apps/agentservice` loads the fault traces in its diagnosis tests. The T2, T3, and T5 catalog fixtures are in this directory for the timeline and diagnosis. The production files are import fixtures. They stay out of the eval manifest because they have no `fault.labels` ground truth.

## Scripts

From the repo root:

```bash
pnpm --filter @mesa/shared build
pnpm --filter @mesa/shared test
pnpm --filter @mesa/shared typecheck
```

`pnpm test` and `pnpm build` at the root include this package through Turbo.
