<!-- eval-scoreboard:start -->
Set valutato: 19 trace, 7 categorie (Plan, ToolUse, Context, Reasoning, Execution, Verification, Security).

Provenienza: 2 fixture già nel repository (`packages/shared/examples/injected-failed-trace.json`, `apps/backend/fixtures/jury/attacked-trace.json`) e 17 trace del harness scriptato. Rigenerare le trace del harness e il manifest con `pnpm generate-dataset` (mock in loopback, driver `scripted`, fault del catalogo). Poi `pnpm eval` riscrive questa sezione.

I conteggi del baseline solo-regole sono stati ricalcolati dopo la [PR #44](https://github.com/mesagroup/MESA-AgentFailureLab/pull/44). Quella PR smette di copiare i marker dell'iniettore negli step, e `pnpm generate-dataset` ha rigenerato le trace del harness su quel codice.

Il ground truth è l'unica etichetta in `fault.labels`. Se `fault.attacker.used` è true, la fonte nel manifest è `fault.attacker`: quell'oggetto non ha una categoria e ADR-002 attribuisce l'etichetta all'attaccante. Il valutatore legge `fault`. Il prompt di Grok no.

### Definizioni
- `category_accuracy`: La categoria predetta è uguale all'unica categoria in `fault.labels`. Astensione e diagnosi fallita contano come errori. Il denominatore è ogni trace del set.
- `step_accuracy_exact`: Lo `step_id` predetto è uguale allo `step_id` dell'etichetta.
- `step_accuracy_tolerance_1`: La differenza assoluta di `step.index` fra predizione ed etichetta è al massimo 1, incluso l'esatto. Uno `step_id` che non è sulla trace è un errore.
- `proposed_fix_hit_rate`: `proposed_fixes` contiene il fix ADR-002 della categoria etichettata: Execution → `controlled_retry`, Verification → `pre_response_check`, Security → `permission_guard`. Plan, ToolUse, Context e Reasoning non hanno un fix MVP e restano fuori dal denominatore. Un fix in più non annulla l'hit. Non è il replay del verificatore.
- `mean_latency_ms`: Media aritmetica di una sola passata, dopo che la trace è già caricata. Non è una mediana e non è un benchmark.
- `tokens_and_cost`: Token e `cost_usd` sono solo quelli riportati dal provider. Se l'usage manca il valore resta assente. I token non vengono convertiti in un prezzo.

La baseline solo-regole prende il primo finding di `diagnosisFindings`, in quest'ordine. Senza finding il metodo si astiene.
- false_success_claim → Verification / pre_response_check
- tool_error → Execution / controlled_retry
- repeated_tool_call → Reasoning / (none)
- timeout → Execution / controlled_retry

> **Colonna Grok — segnaposto.** Non è un risultato. Si riempie eseguendo `pnpm eval` con `XAI_API_KEY` impostata.

| Metrica | Baseline (solo regole) | Grok |
| --- | --- | --- |
| Accuratezza di categoria | 4/19 | *(segnaposto: `pnpm eval` con XAI_API_KEY)* |
| Step esatto | 4/19 | *(segnaposto: `pnpm eval` con XAI_API_KEY)* |
| Step entro ±1 | 10/19 | *(segnaposto: `pnpm eval` con XAI_API_KEY)* |
| Hit del fix proposto | 4/7 | *(segnaposto: `pnpm eval` con XAI_API_KEY)* |
| Fix non applicabile | 12 | *(segnaposto: `pnpm eval` con XAI_API_KEY)* |
| Latenza media (ms) | 0.032 | *(segnaposto: `pnpm eval` con XAI_API_KEY)* |
| Token in/out | n/a | *(segnaposto: `pnpm eval` con XAI_API_KEY)* |
| Costo USD | n/a | *(segnaposto: `pnpm eval` con XAI_API_KEY)* |
<!-- eval-scoreboard:end -->

<!-- eval-limits:start -->
- Hint dell'iniettore in 0/19 trace. Prima della [PR #44](https://github.com/mesagroup/MESA-AgentFailureLab/pull/44) erano 13/19: i marker negli step (`Injected execution drop…`, `Injector skipped`, `forged: true`, `stale: true`, `injected: true`) arrivavano a Grok. Quella PR (@diamanti-sg) non li copia più. Questo eval non modifica `apps/backend`.
- Il driver scriptato dà poca varietà finché non entra l'agent di riferimento ([PR #21](https://github.com/mesagroup/MESA-AgentFailureLab/pull/21)). `pnpm generate-dataset` non copia quell'agent.
- L'efficacia del fix richiede il replay del verificatore ([#15](https://github.com/mesagroup/MESA-AgentFailureLab/issues/15)). La riga del fix nella tabella dice solo se la proposta contiene il fix ADR-002 della categoria etichettata.
- Una sola passata (conteggio: 1). ADR-001 esclude l'aggregazione multi-run.
- Senza `XAI_API_KEY` il costo di Grok è n/a. La baseline solo-regole non riporta token né costo.
<!-- eval-limits:end -->

## Definitions (en)
- `category_accuracy`: Predicted category equals the single fault.labels category. Abstain and a failed diagnosis are misses. The denominator is every scored trace.
- `step_accuracy_exact`: Predicted step_id equals the labelled step_id.
- `step_accuracy_tolerance_1`: Absolute difference of step.index between the prediction and the labelled step is at most 1, including an exact match. A predicted step_id that is not on the trace is a miss.
- `proposed_fix_hit_rate`: The ADR-002 fix for the labelled category appears in proposed_fixes. Execution → controlled_retry, Verification → pre_response_check, Security → permission_guard. Plan, ToolUse, Context, and Reasoning have no MVP fix and are excluded. Extra proposed fixes do not cancel a hit. This is a proposal match, not a verifier replay.
- `mean_latency_ms`: Arithmetic mean of one pass over the scored traces. The timer wraps rulesBaseline or diagnoseTrace after the trace is already loaded. This is a description of that pass, not a tuned benchmark and not a median of repeated trials.
- `tokens_and_cost`: Input and output tokens and cost_usd are whatever the provider reported. Missing usage stays null. Token counts are not converted into a price. Failed diagnoses still add tokens when the provider returned usage before the response was rejected.

## Measurement
- Passes: 1
- Timed region: rulesBaseline or diagnoseTrace, after the trace is loaded
- Baseline limiter: One synchronous walk of the trace steps inside diagnosisFindings. The timer contains no model call and no disk read.
- Grok limiter: The xAI chat completion when XAI_API_KEY is set. With no key the method is skipped and has no latency.
- Cost: Input and output tokens and cost_usd are whatever the provider reported. Missing usage stays null. Token counts are not converted into a price. Failed diagnoses still add tokens when the provider returned usage before the response was rejected.
- Errors: A failed diagnosis stays in the denominator and counts as a miss for category, step, and an applicable fix.
- Generated at: 2026-11-04T13:37:24.072Z

## Leakage
PR #28 wrote fault markers into trace steps that POST /diagnose forwards to Grok. The markers are the tool-result message "Injected execution drop before the mock was called.", system text "Injector skipped" and "Injector target … was not called.", and JSON booleans forged: true, stale: true, and injected: true. PR #44 (@diamanti-sg) stopped copying those markers into steps. This scoreboard was recomputed after pnpm generate-dataset regenerated the harness traces on that injector. The scanner still looks for the same strings in trace.steps. The jury system step that names attacker.payload_id is a separate string: diagnoseTrace drops any step that contains a label code or that payload id. This eval does not change apps/backend.

| Hint | Traces |
| --- | --- |
| dropped_message | 0 |
| injector_skipped | 0 |
| injector_missed_target | 0 |
| forged_true | 0 |
| stale_true | 0 |
| injected_true | 0 |

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
| t1-plan-skip-search | fault.labels | Plan | omitted_required_step | step-1 | Verification | step-3 | no | no | n/a | none |
| t2-plan-skip-add | fault.labels | Plan | omitted_required_step | step-1 | Verification | step-3 | no | no | n/a | none |
| t1-tooluse-forge-search | fault.labels | ToolUse | forged_tool_result | step-2 | Verification | step-5 | no | no | n/a | none |
| t3-tooluse-forge-checkout | fault.labels | ToolUse | forged_tool_result | step-4 | Verification | step-5 | no | yes | n/a | none |
| t4-tooluse-forge-order | fault.labels | ToolUse | forged_tool_result | step-2 | Verification | step-3 | no | yes | n/a | none |
| t1-context-stale-product | fault.labels | Context | stale_tool_result | step-4 | abstain |  | no | no | n/a | none |
| t2-context-stale-cart | fault.labels | Context | stale_tool_result | step-4 | abstain |  | no | no | n/a | none |
| t4-context-stale-order | fault.labels | Context | stale_tool_result | step-2 | Verification | step-3 | no | yes | n/a | none |
| t1-reasoning-mutate-search | fault.labels | Reasoning | wrong_argument | step-1 | abstain |  | no | no | n/a | none |
| t2-reasoning-mutate-qty | fault.labels | Reasoning | wrong_argument | step-1 | Verification | step-5 | no | no | n/a | none |
| t3-reasoning-mutate-checkout | fault.labels | Reasoning | wrong_argument | step-3 | abstain |  | no | no | n/a | none |
| t1-execution-drop-search | fault.labels | Execution | dropped_tool_call | step-2 | Execution | step-2 | yes | yes | hit | none |
| t3-execution-drop-checkout | fault.labels | Execution | dropped_tool_call | step-4 | Execution | step-4 | yes | yes | hit | none |
| t4-execution-drop-order | fault.labels | Execution | dropped_tool_call | step-2 | Execution | step-2 | yes | yes | hit | none |
| t1-verification-skip-product | fault.labels | Verification | suppressed_readback | step-3 | Verification | step-3 | yes | yes | hit | none |
| t3-verification-skip-cart | fault.labels | Verification | suppressed_readback | step-1 | abstain |  | no | no | miss | none |
| t5-security-forge-cancel | fault.labels | Security | forged_permission_success | step-2 | Verification | step-3 | no | yes | miss | none |

