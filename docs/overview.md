# MESA Agent Failure Lab

MESA Agent Failure Lab (CHAOS.AI) is a lab for studying shopping-agent failures against a mock store.

An agent runs a task against a mock e-commerce world. A deterministic verifier decides whether the task succeeded by reading that world, not by asking a model. Faults can be injected. Grok reads the resulting trace and proposes a diagnosis and fixes. Those proposals are not proof: a fix counts only after the harness replays the task and the verifier passes without obvious regressions on other tasks.

## Track

This repository is [Track 03 — Agent Failure Lab / CHAOS.AI](../adr/001-mock-verifier-grok.md). The architectural freeze for the mock, the verifier, and Grok is [ADR-001](../adr/001-mock-verifier-grok.md). Further decisions go in [`adr/`](../adr/README.md) as `NNN-kebab-title.md`. They do not go in this folder.

## Three surfaces

| Path | Team | Owns |
| --- | --- | --- |
| `apps/frontend` | Frontend | Registration, runs, and the trace timeline. Renders `Trace`. Before/after uses `Run` plus `outcome.verifier`. |
| `apps/backend` | Backend | Harness (`baseline` / `injected` / `after_fix`), the deterministic verifier, the labeled injector, and persistence. Not the shop process. |
| `services/mock-shop` | Backend | Stand-alone HTTP shop for T1–T5. The harness and the agent service call it by URL. |
| `apps/agentservice` | AI Engineer | Grok reference agent, diagnosis, and fix proposals. Writes `Trace.diagnosis` only. |
| `packages/shared` | All three | JSON Schema and TypeScript mirrors for `Trace`, `Agent`, and `Run`. |

JSON Schema under `packages/shared/schemas/` is the source of truth for Trace and Agent. OpenAPI may `$ref` those files later. OpenAPI is not the source of truth.

## Hard boundaries

- The mock is the only world state. The attacker and the reference agent act through its tools and API. There is no auth stub.
- `outcome.verifier` is the only success signal. The verifier compares checks to mock state. It does not call Grok and it does not interpret the narrative trace.
- Grok never writes `outcome.verifier` or `fault.labels` (nor `fault.injected` or `fault.attacker`). `diagnosis` stays null until Grok fills it.
- `fault.labels` and `attacker` are ground truth from the injector or the attacker on chaos runs. The jury case is the attacker's path: [demo-jury.md](demo-jury.md).
- `Run` is harness metadata (`phase`, `injection_plan`, `fix_kinds`, `trace_ids`). It is a separate type. It is not nested inside `Trace`.

Out of scope for the MVP, per ADR-001: auth, multi-run aggregation, and using an LLM as the judge of success.
