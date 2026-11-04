# Shop experiment command (#100)

`pnpm demo:shop` completes the shop experiment over the existing HTTP APIs:
clean baseline → explicit fault → persisted diagnosis → selected fix replay →
all clean controls → JSON and Markdown. It does not change the frontend,
register an agent in a live backend, reset a database, or merge code.

## Explicit offline demonstration

From the repository root, after `pnpm install --frozen-lockfile`:

```sh
pnpm demo:shop -- --mode offline
```

This starts private loopback mock-shop, agentservice and backend listeners on
available ports, with private memory stores. It registers the #99 fixture only
in that temporary backend. The planner is the real deterministic HTTP shop
planner. The diagnosis model is an **explicit offline fixture**, proposing
`pre_response_check`; this does not demonstrate Grok quality or availability.
Neither `XAI_API_KEY` nor `DATABASE_URL` is used. Services close at command exit.
No services need to be started separately and no external network is required.

The canonical example runs 13 arms: baseline, injected, replay, then a clean
baseline/treated pair for each of the five registered tasks. Expected offline
contrast: pass → fail → pass, with all five clean pairs passing. The stored
verifier checks, rather than this expectation, determine the reported result.

## Live Grok experiment

Use one backend process with its own dedicated mock-shop. Configure that backend's
`AGENTSERVICE_URL` to a reachable agentservice with `XAI_API_KEY`, using the existing
[getting-started](getting-started.md) and [deploy](deploy.md) instructions. Never
put a key in an Agent document or command argument.

Register the [#99 Agent fixture](../apps/agentservice/scenarios/shop-readback-v1/README.md)
explicitly, setting `instance.base_url` and `test_instance.base_url` to the **same**
reachable deterministic planner. The command reads that existing Agent and checks
that all its task IDs match the scenario's control suite. It never creates or
repairs live agents. Do not use the built-in `reference-shop` as a substitute.

```sh
pnpm demo:shop -- --mode live --backend-url http://127.0.0.1:3001 --agent-id shop-readback-demo-v1 --diagnosis-service-url http://127.0.0.1:3002
```

URLs above are local examples. Public deployments need URLs reachable from both
the backend and the CLI; a remote backend cannot use the CLI machine's localhost.
The optional diagnosis probe URL defaults to the Agent's runtime URL. If these
services differ, supply the probe URL for the **same diagnosis service configured
on the backend**. Health does not expose that backend configuration or prove a
provider call succeeds: a probe cannot certify URL equivalence. The actual
`POST /traces/:id/diagnose` request is always made through the backend, followed
by a read of the persisted Trace. No direct provider call or silent model
fallback is used. Live health must advertise `grok_configured: true`.

A missing key, busy world, failed store/provider request, invalid response or
transport timeout produces an infrastructure error and partial report, not a
fake diagnosis or a verifier failure. An HTTP error is never automatically retried.
A timed-out POST can still finish server-side; inspect its results before rerunning.

## Options and output

`--help` lists all options. `--mode live|offline` is mandatory.

| Option | Meaning |
| --- | --- |
| `--output DIRECTORY` | Default repository-root `demo-results/`, ignored by git. Explicit relative paths resolve from the package working directory. Each execution writes unique `shop-UUID.json` and `.md` files with exclusive writes. |
| `--scenario FILE` | Version 1 shop manifest; defaults to `shop-readback-v1/scenario.json`. Control IDs must exactly cover the registered Agent's tasks. |
| `--task-id ID` | Explicit primary task override within the control suite. A different task/fault pairing may not reproduce the failure. |
| `--fix ID[,ID]` | Explicit **human** treatment; reported as `manual` independently of the diagnostic proposal. This cannot count as a successful Grok proposal. |
| `--timeout-ms N` | Per HTTP request deadline, default 150000; accepted range 1–300000. |
| `--backend-url`, `--agent-id`, `--diagnosis-service-url` | Live targets; forbidden in offline mode. |

JSON and Markdown are generated from the same in-memory report. Stdout prints a
JSON summary with both file paths and exit code. No historical eval/replay report
is overwritten. If writing a report fails, stderr explains that output failed and
the command exits 1; exclusive writes can leave a JSON without its Markdown partner.
Setup failures before an experiment exists (for example, an unreadable manifest)
produce stderr, not a fabricated experiment report.

| Exit code | Meaning |
| --- | --- |
| 0 | Complete experiment with verified treatment. Check `selection.source` to distinguish Grok, offline fixture and human choice. |
| 1 | Preflight, infrastructure, configuration drift or report output error. |
| 2 | Experiment not verified or inconclusive, including no proposed fixes or failed baseline. |
| 64 | Missing, duplicate or invalid CLI arguments. |

## Evidence and decision

Every arm explicitly requests the HTTP driver. Grants come from the same frozen
Agent task setup. Injected and replay arms use the same fault plan, main task and
planner endpoint, and replay links to the injected Run via `parent_run_id`.
Each clean control runs without/with **exactly the selected treatment**, with
`injection: null`; treated controls link to their own clean baseline.
Every returned Run/Trace is validated and reread from persistence before scoring.

Selection uses only the persisted diagnosis's valid `proposed_fixes`, unless the
operator explicitly supplies `--fix`. Empty proposals skip replay and controls
with a visible reason. Neither fault ground truth nor the fixture's
`test_expectations` is a live selector. The latter is excluded from the parsed
execution manifest. There is no category-to-fix fallback.

The shared evidence decision is:

```text
fix_verified = baseline_pass && injected_before_fail && injected_after_pass
               && regressions_complete && !regression
```

Missing/skipped/error arms or incomplete controls yield `null / inconclusive`.
A clean control whose baseline fails is also inconclusive. A complete comparable
experiment where the treatment regresses a clean control yields `false` even if
the injected replay passes. Agent claims and diagnostic confidence do not vote.
The legacy replay uses this decision too, retaining its existing all-fixes
control and scripted-driver limitations; it is not the new HTTP experiment.
Committed historical reports are preserved.

JSON includes the original Run/Trace documents, diagnosis and evidence, full
Agent/scenario snapshot, permissions, driver, parent IDs, timings, errors and
selection provenance. Its Agent snapshot is SHA256 hashed. Client commit and git
dirty state are recorded; backend/planner commits are **unknown**, because existing
health endpoints do not expose them. Agent and backend/mock configuration are
checked before and after each arm. These checks detect observed changes, but are
not an atomic Agent revision lock: do not edit the Agent during the experiment.

`Run.duration_ms` is harness wall time. `Trace.totals.latency_ms` currently sums
synthetic step timings. Diagnosis lookup-to-save wall time and cache state come
from the backend's response headers. Provider model name, token usage and cost
are `null / n/a`, because the persisted diagnosis contract does not expose them.
Harness totals must not be relabelled as diagnosis usage. One controlled case is
not a statistical efficacy estimate; live Grok proposals may vary across runs.

## Boundaries and follow-up

This implements the existing separation in [ADR-001](../adr/001-mock-verifier-grok.md)
(status: proposed) and [ADR-002](../adr/002-fault-injection-and-fixes.md)
(status: accepted); it does not change their status. The backend executes tools
and verifies the world. The deterministic planner supplies actions; Grok diagnoses
post-hoc. This is not a Grok-controlled action loop.

The #97 gate protects reset through result save **within one backend process**.
Diagnosis does not hold that gate. Each arm resets its task setup. Independent
operators can interleave between arms; external resets, multiple backend processes
and persistent world state across arms are outside this experiment's guarantees.
Use a dedicated mock with a single controlling harness. The new library world
(#109 / PR #114) is deliberately rejected by this shop-specific command; its
runtime, schemas and checks are left intact.

The jury runbook (prerequisites, which agent to register, presentation
procedure, Render cold start, real offline results, ADR status) is in
[demo-script.md](demo-script.md#runbook-giuria).
This page remains the command contract (flags, exit codes, evidence formula).
Do not keep a second contradictory manual. The frontend diagnosis/detail/
regression/scoreboard issues remain separate. No live provider execution is
included in offline CI. Live Grok evidence is a later authorized run.
