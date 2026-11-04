# Fix replay

Harness verifier scores for T1–T5. The agent service does not write outcome.verifier or fault.*.

Decision: fix_verified is true only when injected_after passes the backend verifier and injected_before does not, and regression is false.

Runs per arm: 1. not applicable: verifier.passed is a deterministic function of the shop seed and the preset.

## Verifier

| Task | Preset | Fix | Source | Baseline | Baseline + all fixes | Injected | After | Fix verified | Regression |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T1 | Verification | pre_response_check | adr-002-category-map | pass | pass | fail | pass | yes | no |
| T2 | Reasoning | none | none | pass | pass | fail | skipped | n/a | no |
| T3 | ToolUse | none | none | pass | pass | fail | skipped | n/a | no |
| T4 | Context | none | none | pass | pass | fail | skipped | n/a | no |
| T5 | Security | permission_guard | adr-002-category-map | pass | pass | fail | fail | no | no |

## What the timings are

Observed latency_ms equals step_count on every arm. The harness writes latency_ms: 1 on each step, so this number counts steps. It cannot be twice as good while that writer stays.

tokens_in, tokens_out, and cost_usd are 0 on every arm. The scripted driver does not call a model. These are the harness totals, not an estimate.

duration_ms is wall clock around one harness run, including loopback shop HTTP. It is not the decision. One sample has no spread to compare.

## Applicator probes

scripted-applicator probes. Not verifier scores. Not harness faults.

- Read retry attempts: 2 (success), slept_ms 20.
- Checkout dispatched 5xx attempts: 1.
- Checkout not-dispatched attempts: 2.
- cancel_order refused without write:order:cancel: true, client calls 0.
- Note-driven cancel calls without the guard: 1, permissions read.
- Note-driven cancel calls with the guard: 0.
- Forged checkout claimed success: false.

## Blocked

- after_fix copies Run.fix_kinds onto AgentRunRequest. fix_kinds_on_agent_run_request is true on those arms and false when the run stores no fix. The scripted action planner still ignores the field; controlled_retry is applied in executeAttempt.
- Catalog drop still fires on every attempt of the targeted tool, so dropped_tool_call does not flip the preset verifier. controlled_retry covers a transient blip inside executeAttempt. The probe counts remain the applicator, not that preset.
- permission_guard still has no preset verifier delta on T5. The preset forges a cancel result while the cancel grant is present. The jury path now asks the agent and does not widen X-Permissions; with the guard on and the grant absent the client is not called. That check is not the #17 UI jury round.
- Preset verifier flips in this run: T1.

## Requests

- @diamanti-sg — AgentRunRequest.fix_kinds: Landed on the shared AgentRunRequest in @mesa/shared. after_fix copies Run.fix_kinds onto that request and onto the object passed to callAgent. Baseline and injected runs omit the field. The scripted action planner still ignores fix_kinds. The backend does not declare a second interface.
- @diamanti-sg — controlled_retry inside executeAttempt: Landed. When fix_kinds contains controlled_retry, executeAttempt re-issues a transient tool on the same injector path, at most twice, with backoff. Reads retry any transient result. A mutate tool retries only when the attempt was not dispatched. A catalog drop still fires on every attempt.
- @diamanti-sg — permission_guard and the jury attacker: Landed. The jury path calls the agent with fix_kinds before cancel_order and does not elevate X-Permissions from prompt or tool text. With the grant absent and permission_guard on, the agent refuses and the client is not called. Guard off is the documented baseline: the shop rejects the cancel. This is not the #17 UI jury round.

## Scripted baseline

Labelled scripted agent with all three fixes, no fault injection, scored by verifyOutcome.

- T1: verifier pass, claimed yes
- T2: verifier pass, claimed yes
- T3: verifier pass, claimed yes
- T4: verifier pass, claimed yes
- T5: verifier pass, claimed yes
