# MESA Agent Failure Lab

MESA Agent Failure Lab (CHAOS.AI) is a generic lab for agents under test: register an agent, test it with injected faults, inspect the trace, and read a diagnosis with proposed fixes. The same path is meant to cover production runs. This page follows the [v2 racconto](https://cursor.com/canvas/store-dd8d0140-8ad3-43f8-94aa-372bb19c176d/0ad71f2e-bbbc-444f-aab0-7bf91b830aae).

The mock e-commerce shop and the shopping agent (tasks T1–T5) are the demo example that ships in this repository. An agent registers its own tasks. The demo shop is one HTTP target, called by URL.

A deterministic verifier decides whether a task succeeded by reading world state. It does not ask a model. Faults can be injected and are labeled. Grok reads the resulting trace and proposes a diagnosis and fixes. A proposal counts only after the harness replays the task and the verifier passes without obvious regressions on other tasks.

## Domain

The product types live in `packages/shared`. JSON Schema is the source of truth.

| Type | What it is |
| --- | --- |
| Agent | Registration: name, `instance` (`reference` or `external`), `test_instance`, trace location, docs, and a non-empty task list. |
| Task | `task_id`, title, prompt, and `success_test` of type `verifier_checks`. |
| Run | Harness metadata. `phase` is `baseline`, `injected`, or `after_fix`. Holds `injection_plan`, `fix_kinds`, and `trace_ids`. |
| Trace | A separate type: steps, timings, costs, `outcome.verifier`, fault labels, optional `diagnosis`. A Run is not nested inside it. |
| Diagnosis | Written only by Grok: `category`, `cause`, `step_id`, `confidence`, `evidence`, `proposed_fixes`. |
| Fix | MVP kinds on `Run.fix_kinds` and on `diagnosis.proposed_fixes`: `controlled_retry`, `pre_response_check`, `permission_guard`. |

`test_instance` is separate from `instance` so a fix replay can avoid the production endpoint. The reference stub in `packages/shared/examples/agent-reference-stub.json` is the shopping demo. Its five tasks are T1–T5.

## What is implemented

On `main` today:

- Contracts for Agent, Task, Run, and Trace, plus the shopping reference stub.
- The demo shop (`services/mock-shop`, port 8787) and the reference agent (`POST /v1/tasks/run` on port 3002). The agent returns actions with `executed: false`. The harness executes them.
- Harness phases `baseline`, `injected`, and `after_fix`, a labeled fault injector, and the jury attacker for one security case on demo task T5. Runs and traces persist in Postgres when `DATABASE_URL` is set, and stay in memory otherwise. See [architecture](architecture.md) and [the jury demo](demo-jury.md).
- Lab dashboard snapshot. `GET /agents` lists registered agents (`agent_id`, `instance.kind`, task count = `tasks.length`). `GET /runs` lists stored runs, newest start first, with `trace_ids`, the first trace id, and `outcome.verifier` from each linked trace. `counts.scope` is `harness_session`: agents and run statuses in the store this process has open. With Postgres those rows survive a restart. See the [backend README](../apps/backend/README.md#dashboard-snapshot).
- A deterministic verifier. It is the only writer of `outcome.verifier`. On the demo it reads mock state (`GET /internal/state`) and the task checks. It does not call Grok.
- Grok diagnosis (`POST /diagnose`) and the three MVP fix policies in the agent service. A replay in that service scores the demo tasks with the backend verifier (`apps/agentservice/replay/latest.md`). A live `after_fix` run records `fix_kinds` and does not yet send them on the agent run request ([#40](https://github.com/mesagroup/MESA-AgentFailureLab/issues/40), [#41](https://github.com/mesagroup/MESA-AgentFailureLab/issues/41)).
- `pnpm eval`: labeled traces scored against a rules baseline, with an optional Grok column. The numbers in the README are that command's output. CI runs `pnpm eval:gate`, which compares that rules column with `apps/agentservice/eval/baseline.json` and does not need `XAI_API_KEY`.

The web UI dashboard and agent registration call the harness. The run launcher and the trace timeline are still scaffolds.

## Planned

| Surface | Status |
| --- | --- |
| **Dashboard** — registered agents, recent runs, verifier outcome, in-session counts | Home reads `GET /agents` and `GET /runs` ([#77](https://github.com/mesagroup/MESA-AgentFailureLab/issues/77), snapshot [#76](https://github.com/mesagroup/MESA-AgentFailureLab/issues/76)). `counts.scope` is `harness_session` (records in the store this process has open; Postgres keeps runs and traces across a restart). Multi-day series, uptime percentages, and agent ranking stay out, per ADR-001. |
| Agent CRUD in the UI, with the shopping demo preloaded | Planned ([#49](https://github.com/mesagroup/MESA-AgentFailureLab/issues/49)). The API is `GET/POST/PUT/DELETE /agents` ([#50](https://github.com/mesagroup/MESA-AgentFailureLab/issues/50)), and `reference-shop` is seeded. The registration screen is still open. |
| **Testa agente** — start a test, list runs, toggle faults | Planned ([#14](https://github.com/mesagroup/MESA-AgentFailureLab/issues/14)). `POST /runs` starts a batch for the required `agent_id`. The UI that picks the agent is still open. |
| **Ispeziona traccia** — timeline, culprit step, diagnosis when present | Planned ([#12](https://github.com/mesagroup/MESA-AgentFailureLab/issues/12)). `GET /traces` already returns stored traces. Hand-written traces are in `packages/shared/examples`. |
| Open the fix as a GitHub issue | Planned ([#52](https://github.com/mesagroup/MESA-AgentFailureLab/issues/52)). Agent has no destination repository field yet. |
| **Fix → replay → before/after** — choose a proposed fix, replay `after_fix`, compare `outcome.verifier` | Planned ([#53](https://github.com/mesagroup/MESA-AgentFailureLab/issues/53)). `POST /runs` with `phase: after_fix` and `fix_kinds` exists; the fix is recorded, not yet sent to the agent ([#40](https://github.com/mesagroup/MESA-AgentFailureLab/issues/40), [#41](https://github.com/mesagroup/MESA-AgentFailureLab/issues/41)). |
| Demo script and video storyboard | Planned ([#56](https://github.com/mesagroup/MESA-AgentFailureLab/issues/56)) → `docs/demo-script.md`. |

## Under evaluation

These areas are still being shaped. Some lab machinery already exists. The screens and the remaining scope do not.

- **Production.** Import a real trace, mark it as production (no `fault.labels`), and ask for a diagnosis. How that trace gets an outcome is still open ([#51](https://github.com/mesagroup/MESA-AgentFailureLab/issues/51)).
- **Jury.** One attacker case and a written checklist exist ([demo-jury.md](demo-jury.md)). A structured jury (note, task, permissions, outcome, replay with `permission_guard`) is planned ([#55](https://github.com/mesagroup/MESA-AgentFailureLab/issues/55)).
- **Regression.** The demo replay records whether the baseline still passes after a fix. A suite per agent, a comparison with the last baseline, and whether the suite is T1–T5 or custom are open ([#54](https://github.com/mesagroup/MESA-AgentFailureLab/issues/54)).
- **Eval.** The CLI scoreboard is in the README. A screen for it is a stretch and does not block the jury demo ([#57](https://github.com/mesagroup/MESA-AgentFailureLab/issues/57)).

## Open points

- UX for choosing proposed fixes (#53): one fix or several, who confirms.
- Structured jury, as above.
- Regression content: the demo task list versus a custom suite.
- Extra screens beyond Agent CRUD, Testa agente, and Ispeziona traccia.

## Track

This repository is [Track 03 — Agent Failure Lab / CHAOS.AI](../adr/001-mock-verifier-grok.md). The architectural freeze for the mock, the verifier, and Grok is [ADR-001](../adr/001-mock-verifier-grok.md). Further decisions go in [`adr/`](../adr/README.md) as `NNN-kebab-title.md`. They do not go in this folder.

## Code ownership

| Path | Team | Owns |
| --- | --- | --- |
| `apps/frontend` | Frontend | Scaffold today. Planned screens: Agent CRUD, Testa agente, Ispeziona traccia. The timeline will render `Trace`. Before/after will use `Run` plus `outcome.verifier`. |
| `apps/backend` | Backend | Harness (`baseline` / `injected` / `after_fix`), the deterministic verifier, the labeled injector, and Agent/Run/Trace persistence (Postgres or memory). The shop process is separate. |
| `services/mock-shop` | Backend | Demo example: stand-alone HTTP shop for T1–T5. The harness and the agent service call it by URL. |
| `apps/agentservice` | AI Engineer | Grok diagnosis, the MVP fix applicator, and the reference shopping agent. Writes `Trace.diagnosis` only. The verifier still owns `outcome.verifier`. |
| `packages/shared` | All three | JSON Schema and TypeScript mirrors for `Trace`, `Agent`, and `Run`, plus the `AgentRunRequest` type for `POST /v1/tasks/run`. |

JSON Schema under `packages/shared/schemas/` is the source of truth for Trace and Agent. OpenAPI may `$ref` those files later. OpenAPI is not the source of truth.

## Hard boundaries

- On the demo example, the mock shop is the world state. The attacker and the reference shopping agent act through its tools and API. There is no auth stub.
- `outcome.verifier` is the only success signal. The verifier compares checks to world state (mock state, on the demo). It does not call Grok and it does not interpret the narrative trace.
- Grok never writes `outcome.verifier` or `fault.labels` (nor `fault.injected` or `fault.attacker`). `diagnosis` stays null until Grok fills it.
- `fault.labels` and `attacker` are ground truth from the injector or the attacker on chaos runs. The jury case is the attacker's path: [demo-jury.md](demo-jury.md).
- `Run` is harness metadata (`phase`, `injection_plan`, `fix_kinds`, `trace_ids`). It is a separate type. It is not nested inside `Trace`.

Out of scope for the MVP, per ADR-001: auth, multi-run aggregation, and using an LLM as the judge of success. Agent, Run, and Trace rows persist in Postgres when `DATABASE_URL` is set, and stay in memory when it is not. The shop catalog stays in memory. See [persistence.md](persistence.md).
