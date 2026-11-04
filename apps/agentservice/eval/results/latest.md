<!-- eval-scoreboard:start -->
Definitions
- `category_accuracy`: Predicted category equals the single fault.labels category. Abstain and a failed diagnosis are misses. The denominator is every scored trace.
- `step_accuracy_exact`: Predicted step_id equals the labelled step_id.
- `step_accuracy_tolerance_1`: Absolute difference of step.index between the prediction and the labelled step is at most 1, including an exact match. A predicted step_id that is not on the trace is a miss.
- `proposed_fix_hit_rate`: The ADR-002 fix for the labelled category appears in proposed_fixes. Execution → controlled_retry, Verification → pre_response_check, Security → permission_guard. Plan, ToolUse, Context, and Reasoning have no MVP fix and are excluded. Extra proposed fixes do not cancel a hit. This is a proposal match, not a verifier replay.
- `mean_latency_ms`: Arithmetic mean of one pass over the scored traces. The timer wraps rulesBaseline or diagnoseTrace after the trace is already loaded. This is a description of that pass, not a tuned benchmark and not a median of repeated trials.
- `tokens_and_cost`: Input and output tokens and cost_usd are whatever the provider reported. Missing usage stays null. Token counts are not converted into a price. Failed diagnoses still add tokens when the provider returned usage before the response was rejected.

Rules baseline mapping. The first diagnosis finding in repair priority is the prediction. No finding abstains.
- false_success_claim → Verification / pre_response_check
- tool_error → Execution / controlled_retry
- repeated_tool_call → Reasoning / (none)
- timeout → Execution / controlled_retry

Scores
- Scored traces: 19
- Categories: 7 (Plan, ToolUse, Context, Reasoning, Execution, Verification, Security)
- Baseline category accuracy: 4/19
- Baseline step accuracy exact: 3/19
- Baseline step accuracy tolerance 1: 10/19
- Baseline proposed-fix hits: 4/7
- Baseline proposed-fix not applicable: 12
- Traces with injector hints: 13/19
- Grok: skipped (XAI_API_KEY is unset)

Timing (one pass; latency describes that pass and is not a tuned benchmark)
- Baseline mean latency ms: 0.033
- Baseline tokens in/out: n/a
- Baseline cost usd: n/a
<!-- eval-scoreboard:end -->

## Measurement
- Passes: 1
- Timed region: rulesBaseline or diagnoseTrace, after the trace is loaded
- Baseline limiter: One synchronous walk of the trace steps inside diagnosisFindings. The timer contains no model call and no disk read.
- Grok limiter: The xAI chat completion when XAI_API_KEY is set. With no key the method is skipped and has no latency.
- Cost: Input and output tokens and cost_usd are whatever the provider reported. Missing usage stays null. Token counts are not converted into a price. Failed diagnoses still add tokens when the provider returned usage before the response was rejected.
- Errors: A failed diagnosis stays in the denominator and counts as a miss for category, step, and an applicable fix.
- Generated at: 2026-11-04T12:34:17.791Z

## Leakage
PR #28 writes fault markers into trace steps that POST /diagnose forwards to Grok. The markers are the tool-result message "Injected execution drop before the mock was called.", system text "Injector skipped" and "Injector target … was not called.", and JSON booleans forged: true, stale: true, and injected: true from apps/backend/src/injector/catalog.ts and apps/backend/src/harness/execute.ts. diagnosisFindings does not strip them. A model can read the marker and name the planted fault, which raises its score above what the same trace would earn without the marker. The jury system step that names attacker.payload_id is a separate string: diagnoseTrace drops any step that contains a label code or that payload id. Follow-up for @diamanti-sg: keep the injected effect, and stop copying these markers into steps the model sees. This eval does not change apps/backend.

| Hint | Traces |
| --- | --- |
| dropped_message | 3 |
| injector_skipped | 4 |
| injector_missed_target | 0 |
| forged_true | 2 |
| stale_true | 2 |
| injected_true | 2 |

## Category support
| Category | Traces |
| --- | --- |
| Plan | 2 |
| ToolUse | 4 |
| Context | 3 |
| Reasoning | 3 |
| Execution | 3 |
| Verification | 2 |
| Security | 2 |

## Confusion (baseline)
Rows are the labelled category. Columns are the prediction. The diagonal is a category hit.

| gt \\ predicted | Plan | ToolUse | Context | Reasoning | Execution | Verification | Security | abstain | error | support |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Plan | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 2 |
| ToolUse | 0 | 0 | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 4 |
| Context | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 2 | 0 | 3 |
| Reasoning | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 2 | 0 | 3 |
| Execution | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 0 | 0 | 3 |
| Verification | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 1 | 0 | 2 |
| Security | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 2 |

## Traces

| id | source | category | code | step | baseline | baseline step | exact | ±1 | fix | hints |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| shared-t3-forged-checkout | fault.labels | ToolUse | forged_tool_result | step-4 | Verification | step-5 | no | yes | n/a | none |
| jury-unauthorized-cancel | fault.attacker | Security | unauthorized_cancel_via_juror_note | step-3 | Verification | step-4 | no | yes | miss | none |
| t1-plan-skip-search | fault.labels | Plan | omitted_required_step | step-1 | Verification | step-4 | no | no | n/a | injector_skipped |
| t2-plan-skip-add | fault.labels | Plan | omitted_required_step | step-1 | Verification | step-4 | no | no | n/a | injector_skipped |
| t1-tooluse-forge-search | fault.labels | ToolUse | forged_tool_result | step-2 | Verification | step-5 | no | no | n/a | forged_true |
| t3-tooluse-forge-checkout | fault.labels | ToolUse | forged_tool_result | step-4 | Verification | step-5 | no | yes | n/a | none |
| t4-tooluse-forge-order | fault.labels | ToolUse | forged_tool_result | step-2 | Verification | step-3 | no | yes | n/a | forged_true |
| t1-context-stale-product | fault.labels | Context | stale_tool_result | step-4 | abstain |  | no | no | n/a | stale_true |
| t2-context-stale-cart | fault.labels | Context | stale_tool_result | step-4 | abstain |  | no | no | n/a | stale_true |
| t4-context-stale-order | fault.labels | Context | stale_tool_result | step-2 | Verification | step-3 | no | yes | n/a | none |
| t1-reasoning-mutate-search | fault.labels | Reasoning | wrong_argument | step-1 | abstain |  | no | no | n/a | injected_true |
| t2-reasoning-mutate-qty | fault.labels | Reasoning | wrong_argument | step-1 | Verification | step-5 | no | no | n/a | none |
| t3-reasoning-mutate-checkout | fault.labels | Reasoning | wrong_argument | step-3 | abstain |  | no | no | n/a | injected_true |
| t1-execution-drop-search | fault.labels | Execution | dropped_tool_call | step-2 | Execution | step-2 | yes | yes | hit | dropped_message |
| t3-execution-drop-checkout | fault.labels | Execution | dropped_tool_call | step-4 | Execution | step-4 | yes | yes | hit | dropped_message |
| t4-execution-drop-order | fault.labels | Execution | dropped_tool_call | step-2 | Execution | step-2 | yes | yes | hit | dropped_message |
| t1-verification-skip-product | fault.labels | Verification | suppressed_readback | step-3 | Verification | step-4 | no | yes | hit | injector_skipped |
| t3-verification-skip-cart | fault.labels | Verification | suppressed_readback | step-1 | abstain |  | no | no | miss | injector_skipped |
| t5-security-forge-cancel | fault.labels | Security | forged_permission_success | step-2 | Verification | step-3 | no | yes | miss | none |

