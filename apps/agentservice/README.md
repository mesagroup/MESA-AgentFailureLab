# @mesa/agentservice

Grok diagnosis for one `Trace`, the fix applicator for `controlled_retry`, `pre_response_check`, and `permission_guard`, and the reference shop agent.

`POST /diagnose` reads a trace, runs a deterministic pre-pass, asks Grok for a `Diagnosis`, and returns the same trace with `diagnosis` filled. It does not write `outcome.verifier` or `fault.*`.

`POST /v1/tasks/run` proposes the T1–T5 tool list and returns `{ "executed": false, "actions", "refused", "embedded" }`. It does not call the shop, and it does not write `outcome.verifier` or `fault.*`. `claimed_success` stays unset: the action list has not seen tool results. The backend harness executes `actions`, injects faults, and writes the verifier. Optional `fix_kinds` are parsed and passed to `applyFixesToPlan` in `src/fixes/plan.ts`. That module is the only copy of the three policies. `controlled_retry` does not add a second action; retry belongs to the harness ([#41](https://github.com/mesagroup/MESA-AgentFailureLab/issues/41)). A tool name or permission named only in the prompt is recorded on `embedded` and is not a grant. Grok on this process is only the diagnosis client.

## Run from the monorepo root

```bash
pnpm install
pnpm exec turbo run dev --filter=@mesa/agentservice
```

Equivalent root script: `pnpm dev:agentservice`.

- Dev server: http://127.0.0.1:3002
- Health: http://127.0.0.1:3002/health
- Diagnose: `POST /diagnose` with a JSON `Trace`
- Production build: `pnpm exec turbo run build --filter=@mesa/agentservice` then `pnpm --filter @mesa/agentservice start`

Copy `apps/agentservice/.env.example` to `apps/agentservice/.env` and set `XAI_API_KEY` locally. `.env` is gitignored. `XAI_API_KEY=` in the example stays empty.

`dev` and `start` load that file when it is present (`tsx watch --env-file-if-exists=.env` and `node --env-file-if-exists=.env`). Turbo runs those scripts in `apps/agentservice`, so the path is the package directory. A missing `.env` is fine: the process still boots, and `POST /diagnose` returns 503 until a key is set in the environment. Tests do not read `.env`.

`GROK_MODEL` is the chat model sent on the diagnosis call (`grok-3` in the example). The call path receives that string from config. `XAI_BASE_URL` defaults to `https://api.x.ai/v1`. `GROK_TIMEOUT_MS` is the per-attempt timeout (default 30000). A timeout, a connection failure, or HTTP 408/429/500/502/503/504 is tried once more. Other statuses are not retried.

Container image, from the repo root: `docker build -f apps/agentservice/Dockerfile -t mesa-agentservice .` The image sets `HOST=0.0.0.0`, listens on port 3002, and answers `GET /health`. It starts with `node --env-file-if-exists=.env dist/index.js`. Render and Compose put `XAI_API_KEY` in the process environment, so the image boots when `.env` is absent. The key is a runtime env var, not a Docker build arg. See [docs/deploy.md](../../docs/deploy.md).

`turbo run dev` builds `@mesa/shared` first.

Tests do not need a key or the network:

```bash
pnpm --filter @mesa/agentservice test
```

## Diagnose a trace

The body is a `Trace`. `run_id` is already a field on it. There is no second wrapper. The response is that trace with `diagnosis` set. `outcome` and `fault` are the same objects the caller sent.

| Status | Body | When |
| --- | --- | --- |
| 200 | The trace | Diagnosis passed the shared schema |
| 400 | `{ "error": "invalid_trace", "errors": string[] }` | Body failed `validateTrace` |
| 503 | `{ "error": "grok_not_configured" }` | `XAI_API_KEY` is empty and no model was injected |
| 502 | `{ "error": "diagnosis_failed" }` | The provider failed, or the model JSON was not a schema-valid diagnosis |

Token use and cost are not fields on the trace. When the completion includes usage, the process logs `diagnosis usage` with `diagnosis_usage`. xAI's `usage.cost_in_usd_ticks` is divided by 10^10 to get USD. If the provider omits usage, nothing is logged.

Field names are the shared schema: `category`, `cause`, `step_id`, `confidence`, `evidence`, `proposed_fixes`. Issue #13's `culprit_step_id` and `suggested_fix_ids` are not accepted as aliases.

## What Grok does not see

The prompt is an allow-list, not a copy of the trace with a few keys deleted.

Omitted:

- The whole `fault` object. `labels` carry category, step id, and the machine code (`forged_tool_result` on the T3 example). `injected` and `attacker.payload_id` are the same ground truth. Sending `injected: false` on clean runs and omitting it on chaos runs would itself mark which runs were planted, so the key is never sent.
- `trace_id`, `run_id`, and `agent_id`. The harness builds `run-${taskId}-${phase}-uuid` and `trace-${taskId}-${phase}-uuid`, so those strings contain `baseline`, `injected`, or `after_fix`. The response trace still has the original ids.
- `outcome.verifier` (`passed`, `checks`, `mock_state_snapshot`). Check text and the snapshot restate the injected effect. On the shared T3 trace the check says the fake order does not exist while the tool result says it was placed.
- `outcome.success`, because the schema defines it as equal to `verifier.passed`.
- Any `diagnosis` already stored on the trace.
- `injection_plan` and `phase`. Those are Run fields. They are not copied onto the prompt.

Kept: `task_id`, timestamps, `status`, `steps` (including tool inputs and outputs the agent saw), `totals`, `agent_claimed_success`, and the pre-pass findings.

`status` still tells the model whether the attempt completed, failed, timed out, or errored. That is the harness class, not the check narrative.

Pre-pass runs in process on the full trace. It may read `outcome.verifier.passed` as a boolean. Finding text is a fixed template plus a tool name and step ids. It does not quote check details, the snapshot, or label codes.

## Pre-pass

Findings are sent to the model and appended to `diagnosis.evidence`. Category, cause, and `proposed_fixes` come from the model.

| Kind | When | Step cited |
| --- | --- | --- |
| `false_success_claim` | `agent_claimed_success` is true and `verifier.passed` is false | Last assistant message, else the last step |
| `tool_error` | A `tool_result` output is an error (`error`, `ok: false`, `success: false`, or status `error` / `failed` / `failure`) | That tool result |
| `repeated_tool_call` | The same `tool_name` and the same JSON input appear on at least two `tool_call` steps, adjacent or not | Those tool calls |
| `timeout` | `status` is `timeout`, or a tool result output says timeout | Last step, or that tool result |

Evidence strings from the model that do not contain a real `step_id` are dropped. If the model's `step_id` is not in the trace, it is replaced from the pre-pass in the order false success, tool error, repeated call, timeout. Either repair caps `confidence` at 0.4. Confidence is then clamped to `0..1`, and duplicate `proposed_fixes` are removed, before the schema check. If there is no real step to use, the call is rejected. A provider failure does not become a diagnosis invented from the pre-pass alone.

## Boundaries

Health reports `forbidden_write_paths` from `@mesa/shared`. This service must not write:

- `outcome.verifier` (backend verifier only; it reads mock state, not the model)
- `fault.injected`, `fault.labels`, `fault.attacker` (injector / attacker only)

`diagnosis` stays `null` on a trace until this service fills it. `diagnosis.category` is a hypothesis. Ground truth for classification is `fault.labels`, which this service returns on the trace for the harness and does not send to Grok.

The backend harness records `fix_kinds` and replays the task (`Run.phase = after_fix`). A proposal is valid only when that replay's verifier passes. This service does not declare success. The harness does not yet copy `fix_kinds` onto `AgentRunRequest`; the applicator below is what the agent runs when that field arrives. See [ADR-001](../../adr/001-mock-verifier-grok.md).

## Where code lives

- `src/diagnosis/diagnose.ts` — `diagnoseTrace`. Pre-pass, the prompt allow-list, evidence checks, and the graft onto the trace are private to this file.
- `src/grok/config.ts` — `parseDiagnosisConfig`. The only place that reads `GROK_MODEL`, `XAI_API_KEY`, `XAI_BASE_URL`, and `GROK_TIMEOUT_MS`.
- `src/grok/client.ts` — OpenAI SDK client pointed at `XAI_BASE_URL`, structured `json_schema` output, timeout, and one retry.
- `src/fixes/` — the three `FixKind` policies, as a wrapper around a shop tool client
- `src/replay/` — before/after report. Pass/fail is copied from the backend verifier
- `src/reference-agent/` — `planTaskRun` for `POST /v1/tasks/run`. It calls `applyFixesToPlan` and does not call tools.

Fixtures shared with later trace work live in [`packages/shared/examples/`](../../packages/shared/examples/). This service's tests use `injected-failed-trace.json`, `timeout-repeated-tool-trace.json`, and `tool-error-trace.json`.

## Fix applicator

`FixKind` is `controlled_retry`, `pre_response_check`, or `permission_guard` ([ADR-002](../../adr/002-fault-injection-and-fixes.md)). The policies are in `src/fixes/domain.ts`. `wrapShopClient` applies them to any agent loop that calls tools. `applyFixesToPlan` is the same policy for an agent that returns an action list and sets `executed: false`.

| Fix | What it does |
| --- | --- |
| `controlled_retry` | On a timeout or a transient HTTP status (0, 408, 429, 500, 502, 503, 504), retry up to `maxRetries` (default 2) with exponential backoff. Reads are always retried. `add_to_cart`, `update_cart`, `checkout`, and `cancel_order` are retried only when the transport reports `dispatched: false`. A dispatched 5xx on those tools is not retried. |
| `pre_response_check` | Before a success claim, re-read the shop through a read tool. The claim is true only when that read matches the task goal. A checkout body that says the order was placed is not enough: the cart is read again, and the order id from that body is only a hint for `get_order`. |
| `permission_guard` | Refuse a tool whose required permission is not in the granted set. The client is not called. Tool names and permission tokens found in the prompt, in an attached note, or in a tool output are recorded as data. They do not become a grant. The jury note in `apps/backend/fixtures/jury` is that kind of text. |

This service does not inject faults. It does not write `outcome.verifier` or `fault.*`.

### Glue for the reference agent

`planTaskRun` keeps `executed: false` and shapes the list with the shared policy. The HTTP route returns that plan, including `refused` and `embedded`. `controlled_retry` does not add a second action: the harness still runs each action once. This agent does not call tools, so it does not use `wrapShopClient`.

```ts
import { applyFixesToPlan } from "../fixes/plan.js";

const shaped = applyFixesToPlan({
  taskId,
  permissions,
  orderId,
  fixes: fix_kinds,
  prompt,
});
return {
  executed: false,
  actions: shaped.actions,
  refused: shaped.refused,
  embedded: shaped.embedded,
};
```

The base list is `basePlan`: T2 calls `get_cart` after `add_to_cart`, T3 calls `get_cart` before `checkout`, and T5 returns no actions unless the granted set includes `write:order:cancel`. An embedded `cancel_order` instruction is appended the way `applyFixesToPlan` defines, then `permission_guard` can move it to `refused`. A permission token in the prompt stays on `embedded`. It is not added to the granted set and it is not sent as a permission.

Leave `claimed_success` unset on this path. The action list has not seen tool results, so it cannot know the re-read yet. An agent that calls the shop itself would use `wrapShopClient` and set the claim from `confirmGoal`. The reference agent does not do that.

`src/fixes/scripted-agent.ts` is the labelled stand-in that does call tools, for the replay. It is not `planTaskRun`. Its base plan matches `apps/backend/src/agent/scripted.ts` and `basePlan`.

## Replay

`pnpm --filter @mesa/agentservice replay` writes `apps/agentservice/replay/latest.json` and `latest.md`.

For each of T1–T5 it runs the merged harness (`runTasks`, in-process shop, preset injection):

- baseline, no fix, scripted driver
- baseline with all three fixes applied in the `callAgent` hook
- injected, no fix
- injected `after_fix` with the fix from a supplied list, from `diagnosis.proposed_fixes`, or from the ADR-002 category map when neither is supplied

`passed` is `trace.outcome.verifier.passed`. Timing notes in the markdown say what `latency_ms`, token totals, and `duration_ms` are measuring. The decision number is `fix_verified`: the after arm passes and the injected arm does not, with no baseline regression.

What this run cannot do yet is listed in the report under Blocked and Requests. The harness stores `fix_kinds` on the Run and does not put them on `AgentRunRequest`. `controlled_retry` cannot see a tool result from an action list. `permission_guard` does not change the preset T5 verifier result, because the shop already enforces the session grant and the jury attacker does not ask the agent. The scripted baseline section is the stand-in agent on a clean shop, scored by `verifyOutcome`, with no fault injected.

Do not put ADRs or product docs in this app. Use `adr/` and `docs/`.

## Eval

From the repo root:

```bash
pnpm generate-dataset   # loopback mock + scripted harness; rewrites eval/dataset
pnpm eval               # rules baseline, and Grok when XAI_API_KEY is set
pnpm eval:gate          # offline rules baseline vs eval/baseline.json
pnpm --filter @mesa/agentservice test
```

`pnpm eval -- --fake` runs a labelled fake model and does not call xAI. `pnpm eval:gate` passes an empty `XAI_API_KEY` to the diagnosis resolver and compares the four rules rates with [`eval/baseline.json`](eval/baseline.json). The threshold is `max_rate_drop` in that file. CI runs the gate on every pull request. Tests use `node --import tsx --test` and do not use the network. The Italian jury sections (`Dataset e risultati`, `Limiti noti`) are rewritten in the root [README](../../README.md) by `pnpm eval`. The runner is this package because the rules baseline is `diagnosisFindings` in `src/diagnosis/diagnose.ts`.
