# Canonical shop readback experiment v1

Issue #99 supplies a **scenario contract and isolated integration tests** for
#100. It does not implement the demo CLI, report scoring, world lock, warehouse,
or frontend. The existing planner, injector, verifier and shared schemas are
unchanged. The recorded statuses of ADR-001/002 are unchanged.

## Files and ownership

- `agent.json`: complete schema-valid Agent with five data-driven tasks. It is
  registered explicitly, never automatically seeded. It does not load or depend
  on the `reference-shop` record, its T1–T5 IDs or the decision in #92.
- `scenario.json`: versioned experiment data: task, explicit fault plan, HTTP
  driver, complete clean-control list and **test-only expectations**.
- `../../test/canonical-scenario.test.ts`: exercises the real backend,
  agentservice and mock shop over loopback HTTP on fresh ephemeral ports. Every
  attempt in each experiment is serial; no shared Render/local target is used.

The Agent uses the existing deterministic `/v1/tasks/run` planner. Grok's role is
diagnosis after execution, not action selection. `instance` and `test_instance`
must point to the **same** agentservice in this experiment. This is a conscious
control: changing endpoint or driver at the same time as applying a fix would
confound the comparison. No `auto` fallback, local `callAgent` hook, second
injector, model-written verdict or script-only action adapter is used.

## World, task and intervention

The main task `read-product` searches `mug` and opens `SKU-MUG-01`. Its checks
are `catalog_read(query=mug)` and `product_viewed(product_id=SKU-MUG-01)`, with
empty initial cart/orders and the sole `read` permission. The existing shop seed
provides this SKU; see `services/mock-shop/src/catalog.ts`. Each attempt restores
that seed through the normal harness setup. The scenario is not a physics or
inventory simulation and does not mutate the shop implementation.

The fault is `Verification / suppressed_readback`, targeting `get_product`.
The existing injector omits the first matching product read **once per
attempt**. There is deliberately no `at_step`: a new confirming read can change
indices, but the target/effect must stay identical. The intervention under test
is `pre_response_check`, which appends another read to the proposed action list.

| Arm | Run phase | Injection | Test intervention | Expected verifier |
| --- | --- | --- | --- | --- |
| baseline | baseline | null | none | pass |
| injected | injected | explicit scenario plan | none | fail: product_viewed |
| after_fix | after_fix | same scenario plan | pre_response_check | pass |
| clean_after_fix | after_fix | null | pre_response_check | pass |
| negative_no_fix | injected | same scenario plan | none | fail: product_viewed |
| negative_irrelevant_fix | after_fix | same scenario plan | permission_guard | fail: product_viewed |

No fix is stored on a baseline. Treated clean controls use
`phase:after_fix`, `injection:null`, and the nonempty fix list. The principal
after-fix run links `parent_run_id` to the injected run; a clean treated control
links to its own clean baseline. The backend generates session/order IDs and the
ground-truth step label. Compare the fault plans excluding only that generated
`ground_truth.step_id`; do not weaken/change the fault to obtain a pass.

The omission produces no product read in the real shop observations. With the
intervention, the first read is still omitted and the second really reaches the
shop. Tests verify HTTP calls, action lists, snapshots and verifier checks. The
agent can claim success even in failed arms: its prose is not the verdict.

## Complete clean-control set

No compatible task of this fixture is excluded:

| Task | Initial setup and grant | Checks |
| --- | --- | --- |
| read-product | empty; read | catalog_read, product_viewed |
| add-mugs | empty; read + write:cart | cart_contains SKU-MUG-01 qty 2 |
| checkout-cart | seed 2 mugs; read + write:order | order_created, cart_empty, order_total_matches |
| track-order | seed/checkout 2 mugs; read | order_status_read |
| cancel-order | seed/checkout 2 mugs; read + write:order:cancel | cancel_respects_permission |

Each is run clean without and with the **same** `pre_response_check` treatment.
All ten verifier results must pass. Snapshot/session IDs differ by design;
agent/task definitions, setup, permissions, driver and endpoint do not.

An additional **synthetic negative probe**, explicitly separate from these clean
controls, applies the existing `Reasoning / wrong_argument` fault to
`add_to_cart`. The snapshot then has quantity 1 instead of 2 and the
`cart_contains` check fails. The test's evidence matrix must retain that failure
alongside the passing baseline. This proves that a control failure is visible;
it is not a claim that `pre_response_check` itself causes this regression.
The production report's `fix_verified` aggregation, including handling of
missing controls/regressions, remains work for #100. This PR does not change it.

## Offline verification before #97

From the monorepo root, with the repository's pinned pnpm:

```bash
pnpm install --frozen-lockfile
pnpm --filter @mesa/shared build
pnpm --filter @mesa/agentservice typecheck
pnpm --filter @mesa/agentservice exec node --import tsx --test test/canonical-scenario.test.ts
```

Six tests check the fixture contract, six-arm matrix, all clean controls plus a
synthetic failure, persisted diagnosis/replay through #98, a new notebook task
with SKU-NOTE-05 and different task/agent IDs, and unavailable diagnosis without
fallback. Test output contains machine-readable diagnostic rows labeled
`offline-contract-test`, generated from the verifier results of that execution.
It does not rewrite historical eval/replay reports or commit run IDs/results.

Only diagnosis is stubbed, through the service's explicit model injection. The
model sees the normal filtered prompt; tests assert that fault metadata and
verifier snapshots are absent. An integration test replays the proposed fixes
actually returned/persisted by that **offline model**. Another uses `model:null`
and verifies HTTP 503, unchanged `diagnosis:null`, no invented fix and no replay.
An environment `XAI_API_KEY` cannot activate a real model in these tests: config
and model are supplied explicitly. They make no xAI calls and provide no evidence
of live Grok classification quality.

This can run before #97 because each test owns the entire backend/planner/mock
stack and awaits each attempt. **Seriality inside one test/CLI does not protect
a shared shop from another client.** Shared-demo validation remains dependent on
#97 and the single-writer topology; do not run these manual requests against the
shared demo shop before that boundary is in place.

## Handoff to #100 and manual/live requests

The #100 CLI should validate `schema_version:1`, load/validate the complete Agent,
resolve an explicitly selected scenario and preserve its parameters across all
arms. `test_expectations.reference_fix` and the other expectation fields are an
answer key for contract tests, **never a live fix selector or model prompt**.
Live selection comes only from persisted `diagnosis.proposed_fixes`, or from an
explicitly labeled human intervention. A different/empty proposal may fail or
skip replay; record it rather than substituting the reference fix. Keep the
scenario manifest/ground truth out of the diagnostic prompt.

On a **dedicated** stack, explicitly register `agent.json` with `POST /agents`,
patching both endpoint URLs to the same real service first. The file defaults to
`http://127.0.0.1:3002`; do not silently overwrite an existing registration. HTTP
409 means choose a fresh explicit agent ID or manage that fixture deliberately.
This versioned fixture is not a replacement for arbitrary user agents.

Requests below are JSON bodies for the existing `POST /runs` endpoint, not a new
command. They are exercised by the integration tests. Start with:

```json
{
  "agent_id": "shop-readback-demo-v1",
  "task_ids": ["read-product"],
  "phase": "baseline",
  "driver": "http",
  "injection": null
}
```

For the injected run, set `phase:injected` and copy **the full
`scenario.json.injection_plan` object** into `injection` (not `preset`: these are
custom task IDs). Obtain the returned `run.run_id` and `trace.trace_id` from
`results[0]`. Request persisted diagnosis with
`POST /traces/<trace_id>/diagnose` and no body. This fixture's tasks omit
`evalset`, so agentservice receives the trace alone. A task that stores one is
sent as `{ "trace", "task_evalset" }` guidance; the saved field is still only
`diagnosis`. For replay, use:

```json
{
  "agent_id": "shop-readback-demo-v1",
  "task_ids": ["read-product"],
  "phase": "after_fix",
  "driver": "http",
  "injection": {
    "fault": "Omit the first product read needed to confirm the task.",
    "target": "get_product",
    "ground_truth": { "category": "Verification", "code": "suppressed_readback" }
  },
  "fix_kinds": ["pre_response_check"],
  "parent_run_id": "REPLACE_WITH_INJECTED_RUN_ID"
}
```

Here `pre_response_check` is an **example explicit intervention**. In a live
diagnosis-driven replay, substitute exactly the returned valid proposed list;
if empty, do not issue an invalid after_fix with no fixes. For each clean task,
run a baseline and a treated `after_fix` with `injection:null`. Neither the
reference answer nor this README justifies silently claiming Grok proposed it.

No live trial is performed by this fixture or its tests. When a live trial is
run later, record the code commit, scenario version, full Agent/config, driver,
service identity/configuration, source of fix selection, Run/Trace IDs, check
results, failures/skips and measured provider usage (or n/a). UUIDs/timestamps
vary. `Trace.totals.latency_ms` currently counts synthetic step timing; it is not
model latency. A single controlled success does not establish general efficacy.

## Architectural references

- [ADR-001](../../../../adr/001-mock-verifier-grok.md): world state, verifier,
  diagnosis and ground-truth ownership; proposed status is not altered here.
- [ADR-002](../../../../adr/002-fault-injection-and-fixes.md): one injector,
  mediated actions, existing FixKind names and distinction from Security/jury.
- [Task data](../../../../docs/agent-tasks.md): setup, registered check types
  and schema validation.
- [Backend diagnosis contract](../../../backend/README.md#diagnose-a-stored-trace):
  #98 API, cache/conflict behavior and metadata limits.
- #97 protects the shared world; #100 implements CLI/report; #101 owns final
  shared-demo validation. None is implemented implicitly by this fixture.
