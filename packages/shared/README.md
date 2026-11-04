# @mesa/shared

Cross-app contracts for Agent Failure Lab. Apps depend on this package. Feature code does not live here.

## Source of truth

JSON Schema is the source of truth for **Trace** and **Agent**. OpenAPI is not. A future mock OpenAPI document may `$ref` these files. `Run` is a separate harness record with its own schema, and it is not a field of `Trace`.

| Schema | TypeScript mirror | Id |
| --- | --- | --- |
| `schemas/trace.schema.json` | `src/trace.ts` | `urn:mesa:agent-failure-lab:trace` |
| `schemas/agent.schema.json` | `src/agent.ts` | `urn:mesa:agent-failure-lab:agent` |
| `schemas/run.schema.json` | `src/run.ts` | `urn:mesa:agent-failure-lab:run` |

Package exports:

- `@mesa/shared` — `CONTRACT_VERSION`, `GROK_FORBIDDEN_WRITE_PATHS`, and the TypeScript types
- `@mesa/shared/schemas/trace.schema.json` (and `agent`, `run`)

When a contract field changes:

1. Edit the JSON Schema.
2. Update the TypeScript mirror in the same change.
3. Bump `CONTRACT_VERSION` in `src/index.ts`.
4. Run `pnpm --filter @mesa/shared test`.

`src/schemas.test.ts` locks the freeze (required fields, step shape, fault categories, run phases, and that phase/fix metadata is not inside Trace).

## Freeze (0.1.0)

**Trace.** `trace_id`, `agent_id`, `run_id`, `task_id`, `started_at`, `ended_at`, `status`, `steps`, `outcome.verifier`, `totals`, `fault`, `diagnosis`.

Each step has `step_id`, `index`, `type` (`message` \| `tool_call` \| `tool_result` \| `system`), `timestamp`, `role`, `content`, plus optional `tool_name`, `tool_call_id`, `tool_input`, `tool_output`, `tool_error`, `latency_ms`, `token_usage`, and `cost_usd`.

`outcome.verifier` is `{ passed, checks, mock_state_snapshot }` and the only success signal. `status` is the execution lifecycle (`running` \| `completed` \| `error` \| `cancelled`), not success.

`totals` is `{ latency_ms, tokens, cost_usd }`.

`fault` is `{ injected, labels, attacker }`. Label `category` is `Plan` \| `ToolUse` \| `Context` \| `Reasoning` \| `Execution` \| `Verification` \| `Security`.

`diagnosis` is `null` until Grok writes `{ category, cause, step_id, confidence, evidence, proposed_fixes }`.

**Agent.** `agent_id`, `name`, optional `description`, `created_at`, `updated_at`, `instance` (`kind` `reference` \| `external`, optional `base_url` and `runtime`), `test_instance` (`base_url`, optional `runtime`), `traces` (`store`, optional `path_or_url`), `docs`, and `tasks`. Each task has `task_id`, `title`, `prompt`, and `success_test` of type `verifier_checks` with `checks[]`. A check's `assertion` is a deterministic mock-state check for the verifier, not a prompt.

**Run.** Separate type. `run_id`, `phase` (`baseline` \| `injected` \| `after_fix`), optional `injection_plan_id`, optional `fix_id` / `fix_summary` / `fix_applied_at`, and `trace_id`. `run_id` is the harness record Trace points at with `Trace.run_id`.

## Who may write what

| Region | Writer |
| --- | --- |
| `outcome.verifier` | Backend verifier, from task checks and mock state |
| `fault.injected`, `fault.labels`, `fault.attacker` | Injector / attacker |
| `diagnosis` | Agent service (Grok). Null before that |
| `Run.phase`, `injection_plan_id`, `fix_*` | Backend harness |

`GROK_FORBIDDEN_WRITE_PATHS` lists the Trace paths the agent service must not write. The type system does not enforce this; the services do.

Build from the repo root with `pnpm exec turbo run build --filter=@mesa/shared`.
