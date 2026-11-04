# MESA Agent Failure Lab

MESA Agent Failure Lab (CHAOS.AI) is a generic lab for agents under test: register an agent, test it with injected faults, inspect the trace, and read a diagnosis with proposed fixes. The same path is meant to cover production runs. This page follows the [v2 racconto](https://cursor.com/canvas/store-dd8d0140-8ad3-43f8-94aa-372bb19c176d/0ad71f2e-bbbc-444f-aab0-7bf91b830aae).

The mock e-commerce shop and the shopping agent (tasks T1–T5) are the demo example that ships in this repository. A library desk seed is also registered on boot. An agent registers its own tasks. The demo shop is one HTTP target, called by URL. The library mock is another.

A deterministic verifier decides whether a task succeeded by reading world state. It does not ask a model. Faults can be injected and are labeled. Grok reads the resulting trace and proposes a diagnosis and fixes. A proposal counts only after a later run: the agent owner has changed the agent on their own deploy, the harness starts that run, and the verifier passes without obvious regressions on other tasks. That run is `after_fix`. The lab does not hot-patch the agent in place.

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

`test_instance` is separate from `instance` so an `after_fix` run can call the owner's test deploy instead of the production endpoint. The reference shop agent in `packages/shared/examples/agent-reference-shop.json` is the shopping demo. Its five tasks are T1–T5. A second seed, `external-library`, is the library desk (`packages/shared/examples/agent-library-desk.json`). Its tasks are not shop tasks. Seed URLs for both are resolved per environment ([seed-endpoints.md](seed-endpoints.md)).

## What `after_fix` means

`after_fix` is a later run. The agent owner changes the agent on their own deploy, then the harness starts a new run against that deploy. Baseline calls `instance.base_url`. Injected and `after_fix` call `test_instance.base_url`. The lab does not hot-patch the agent in place, and it does not apply the fix by editing the lab world.

The harness can still send `fix_kinds` on that new request. [#40](https://github.com/mesagroup/MESA-AgentFailureLab/issues/40) copies `Run.fix_kinds` onto `AgentRunRequest`. [#41](https://github.com/mesagroup/MESA-AgentFailureLab/issues/41) applies `controlled_retry` inside `executeAttempt` for the attempt. `pre_response_check` and `permission_guard` can shape the action list returned for that request. Those flags are runtime behavior for the new run. They do not rewrite the stored agent or the owner's deployment.

`outcome.verifier` stays the only deterministic pass or fail ([ADR-001](../adr/001-mock-verifier-grok.md)). Grok writes `diagnosis`, including `proposed_fixes`, and nothing else. A proposal counts when that later run's verifier passes, without obvious regressions on other tasks.

## What is implemented

On `main` today:

- Contracts for Agent, Task, Run, and Trace, plus the shopping reference agent.
- The demo shop (`services/mock-shop`, port 8787) and the reference agent (`POST /v1/tasks/run` on port 3002). The agent returns actions with `executed: false`. The harness executes them.
- Harness phases `baseline`, `injected`, and `after_fix`, a labeled fault injector, and the jury attacker. `POST /attacker/jury-case` takes a note, a task (default T5), and a session grant, returns `outcome.verifier` with a baseline comparison and `links.attacked_trace`, and can start a new `after_fix` run with `permission_guard` on the request. Runs and traces persist in Postgres when `DATABASE_URL` is set, and stay in memory otherwise. See [architecture](architecture.md) and [the jury demo](demo-jury.md).
- Lab dashboard. The home page reads `GET /agents` and `GET /runs` ([#77](https://github.com/mesagroup/MESA-AgentFailureLab/issues/77), snapshot [#76](https://github.com/mesagroup/MESA-AgentFailureLab/issues/76)). `GET /agents` lists registered agents (`agent_id`, `instance.kind`, task count = `tasks.length`). `GET /runs` lists stored runs, newest start first, with `trace_ids`, the first trace id, and `outcome.verifier` from each linked trace. `counts.scope` is `harness_session`: agents and run statuses in the store this process has open. With Postgres those rows survive a restart. Multi-day series, uptime percentages, and agent ranking stay out, per ADR-001. See the [backend README](../apps/backend/README.md#dashboard-snapshot).
- Agent CRUD. The agents page calls `GET/POST/PUT/DELETE /agents` ([#49](https://github.com/mesagroup/MESA-AgentFailureLab/issues/49), API [#50](https://github.com/mesagroup/MESA-AgentFailureLab/issues/50)). `reference-shop` and `external-library` are seeded. A run launches from that page.
- **Testa agente.** The runs page lists stored runs ([#14](https://github.com/mesagroup/MESA-AgentFailureLab/issues/14)). `POST /runs` starts a batch for the required `agent_id` from the agent page. A row opens `/traces/:traceId` when a trace is stored, and `/runs/:runId` otherwise.
- Demo script and video storyboard ([#56](https://github.com/mesagroup/MESA-AgentFailureLab/issues/56)) in [demo-script.md](demo-script.md).
- `after_fix` request wiring. A live `after_fix` run stores `fix_kinds` and the harness sends them on the agent run request ([#40](https://github.com/mesagroup/MESA-AgentFailureLab/issues/40)). `controlled_retry` runs inside `executeAttempt` on that attempt ([#41](https://github.com/mesagroup/MESA-AgentFailureLab/issues/41)). See [What `after_fix` means](#what-after_fix-means).
- A deterministic verifier. It is the only writer of `outcome.verifier`. On the demo it reads mock state (`GET /internal/state`) and the task checks. It does not call Grok.
- Grok diagnosis (`POST /diagnose`). It writes `diagnosis` and `proposed_fixes` only. A replay in the agent service scores the demo tasks with the backend verifier (`apps/agentservice/replay/latest.md`).
- The library desk on main: seed `external-library`, `apps/library-agent`, and `services/mock-library`, described in [agent-tasks.md](agent-tasks.md) and [seed-endpoints.md](seed-endpoints.md). That is the seed and the docs. [#109](https://github.com/mesagroup/MESA-AgentFailureLab/issues/109) is still open. This page does not close it.
- `pnpm eval`: labeled traces scored against a rules baseline, with an optional Grok column. The numbers in the README are that command's output. CI runs `pnpm eval:gate`, which compares that rules column with `apps/agentservice/eval/baseline.json` and does not need `XAI_API_KEY`.

## Planned

| Surface | Status |
| --- | --- |
| **Ispeziona traccia** — timeline, culprit step, diagnosis when present | Open ([#12](https://github.com/mesagroup/MESA-AgentFailureLab/issues/12), reopened). `/traces/:traceId` loads `GET /traces/:traceId`. Hand-written traces are in `packages/shared/examples`. The timeline issue is not closed. |
| Diagnosis panel and `proposed_fixes` | Open ([#103](https://github.com/mesagroup/MESA-AgentFailureLab/issues/103)). |
| Agents and launch feedback — loading, toast, progress | Open ([#104](https://github.com/mesagroup/MESA-AgentFailureLab/issues/104)). |
| Runs detail — `/runs/:runId` and error messages | Open ([#105](https://github.com/mesagroup/MESA-AgentFailureLab/issues/105)). |
| Traces index — `/traces` as a list, not a stub | Open ([#106](https://github.com/mesagroup/MESA-AgentFailureLab/issues/106)). |
| Dashboard counts — Failed includes runs in `error` | Open ([#107](https://github.com/mesagroup/MESA-AgentFailureLab/issues/107)). |
| No localhost on a public deploy | Open ([#108](https://github.com/mesagroup/MESA-AgentFailureLab/issues/108)). Block agent endpoints that a public deploy cannot call. |
| Open the fix as a GitHub issue | Planned ([#52](https://github.com/mesagroup/MESA-AgentFailureLab/issues/52)). Agent has no destination repository field yet. |
| **Fix → replay → before/after** — choose a proposed fix, start `after_fix`, compare `outcome.verifier` | Planned ([#53](https://github.com/mesagroup/MESA-AgentFailureLab/issues/53)). `POST /runs` with `phase: after_fix` and `fix_kinds` is on main ([#40](https://github.com/mesagroup/MESA-AgentFailureLab/issues/40), [#41](https://github.com/mesagroup/MESA-AgentFailureLab/issues/41)). The screen is not. The run is a new call to the owner's deploy, not an in-lab patch. |

## Under evaluation

These areas are still being shaped. Some lab machinery already exists. The screens and the remaining scope do not.

- **Production.** Import a real trace, mark it as production (no `fault.labels`), and ask for a diagnosis. How that trace gets an outcome is still open ([#51](https://github.com/mesagroup/MESA-AgentFailureLab/issues/51)).
- **Jury.** The harness launch is on main ([demo-jury.md](demo-jury.md#frontend-contract-issue-55)). The form that posts the note, task, and permissions, and the click that opens Ispeziona traccia, are still open on the frontend ([#55](https://github.com/mesagroup/MESA-AgentFailureLab/issues/55), trace page [#12](https://github.com/mesagroup/MESA-AgentFailureLab/issues/12)).
- **Regression.** The demo replay records whether the baseline still passes after a fix. A suite per agent, a comparison with the last baseline, and whether the suite is T1–T5 or custom are open ([#54](https://github.com/mesagroup/MESA-AgentFailureLab/issues/54)).
- **Eval.** The CLI scoreboard is in the README. A screen for it is a stretch and does not block the jury demo ([#57](https://github.com/mesagroup/MESA-AgentFailureLab/issues/57)).

## Open points

- UX for choosing proposed fixes (#53): one fix or several, who confirms.
- Jury form. The harness fields are in [demo-jury.md](demo-jury.md#frontend-contract-issue-55). The trace page already loads `GET /traces/:traceId`.
- Regression content: the demo task list versus a custom suite.
- Extra screens beyond Agent CRUD, Testa agente, and Ispeziona traccia.

## Track

This repository is [Track 03 — Agent Failure Lab / CHAOS.AI](../adr/001-mock-verifier-grok.md). The architectural freeze for the mock, the verifier, and Grok is [ADR-001](../adr/001-mock-verifier-grok.md). Further decisions go in [`adr/`](../adr/README.md) as `NNN-kebab-title.md`. They do not go in this folder.

## Code ownership

| Path | Team | Owns |
| --- | --- | --- |
| `apps/frontend` | Frontend | Dashboard, agent CRUD, runs list, and the trace page. The page renders `Trace`. Before/after will use `Run` plus `outcome.verifier`. |
| `apps/backend` | Backend | Harness (`baseline` / `injected` / `after_fix`), the deterministic verifier, the labeled injector, and Agent/Run/Trace persistence (Postgres or memory). The shop (`services/mock-shop`), the library mock (`services/mock-library`), and the library desk (`apps/library-agent`) are separate processes. |
| `services/mock-shop` | Backend | Demo shop: stand-alone HTTP target for T1–T5. The harness calls it by URL. |
| `services/mock-library` | Backend | Demo library world for `external-library`. Stand-alone HTTP target. The harness calls the URL stored on that agent. |
| `apps/agentservice` | AI Engineer | Grok diagnosis and the reference shopping agent. Writes `Trace.diagnosis` only. On an `after_fix` request it may shape that run's action list from `fix_kinds`. It does not rewrite the owner's deploy. The verifier still owns `outcome.verifier`. |
| `packages/shared` | All three | JSON Schema and TypeScript mirrors for `Trace`, `Agent`, and `Run`, plus the `AgentRunRequest` type for `POST /v1/tasks/run`. |

JSON Schema under `packages/shared/schemas/` is the source of truth for Trace and Agent. OpenAPI may `$ref` those files later. OpenAPI is not the source of truth.

## Hard boundaries

- On the shop demo, the mock shop is the world state. The attacker and the reference shopping agent act through its tools and API. The library desk uses the library mock the same way. There is no auth stub.
- `outcome.verifier` is the only success signal. The verifier compares checks to world state (mock state, on the demo). It does not call Grok and it does not interpret the narrative trace.
- Grok never writes `outcome.verifier` or `fault.labels` (nor `fault.injected` or `fault.attacker`). `diagnosis` stays null until Grok fills it.
- `fault.labels` and `attacker` are ground truth from the injector or the attacker on chaos runs. The jury case is the attacker's path: [demo-jury.md](demo-jury.md).
- `Run` is harness metadata (`phase`, `injection_plan`, `fix_kinds`, `trace_ids`). It is a separate type. It is not nested inside `Trace`.

Out of scope for the MVP, per ADR-001: auth, multi-run aggregation, and using an LLM as the judge of success. Agent, Run, and Trace rows persist in Postgres when `DATABASE_URL` is set, and stay in memory when it is not. The shop catalog and the library catalog stay in memory. See [persistence.md](persistence.md).

## Not in these pages

Evalset and OpenTelemetry ([#118](https://github.com/mesagroup/MESA-AgentFailureLab/issues/118)–[#121](https://github.com/mesagroup/MESA-AgentFailureLab/issues/121)) and the E7 competitive analysis ([#126](https://github.com/mesagroup/MESA-AgentFailureLab/issues/126)–[#131](https://github.com/mesagroup/MESA-AgentFailureLab/issues/131)) stay out of the product docs until they land in code or schema. This folder does not specify them. The owner note on `after_fix` in [#126](https://github.com/mesagroup/MESA-AgentFailureLab/issues/126) is already the rule in [What `after_fix` means](#what-after_fix-means).
