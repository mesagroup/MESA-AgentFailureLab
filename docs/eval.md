# Eval del dataset

Track 03 chiede un set etichettato e il confronto fra un baseline solo-regole e Grok. I numeri della tabella stanno nel README, fra i marcatori `eval-scoreboard` e `eval-limits`. Li scrive `pnpm eval`. Questo file spiega le definizioni e registra il confronto prima/dopo la [PR #44](https://github.com/mesagroup/MESA-AgentFailureLab/pull/44).

## Comandi

Dalla radice del repository:

```bash
pnpm generate-dataset
pnpm eval
```

`pnpm generate-dataset` avvia il mock shop in loopback e il driver `scripted` del harness già in main, con i fault del catalogo. Non chiama l'agent di riferimento della [PR #21](https://github.com/mesagroup/MESA-AgentFailureLab/pull/21). Una seconda esecuzione cambia gli id e i timestamp, perché l'harness usa `randomUUID` e `Date.now`.

`pnpm eval` legge il manifest `apps/agentservice/eval/dataset/manifest.json`, calcola il baseline solo-regole e, se `XAI_API_KEY` è impostata, chiama Grok. Senza chiave la colonna Grok resta il segnaposto. `pnpm eval -- --fake` usa un modello etichettato `fake-diagnosis` e non è un punteggio di Grok.

Il report completo (confusione, hint per tipo, una riga per trace) è [apps/agentservice/eval/results/latest.md](../apps/agentservice/eval/results/latest.md).

## Conteggio dopo la PR #44

I numeri pubblicati prima della [PR #44](https://github.com/mesagroup/MESA-AgentFailureLab/pull/44) erano stati calcolati su trace del harness che contenevano ancora i marker dell'iniettore. Su main, dopo quella PR, `pnpm generate-dataset` e `pnpm eval` (senza `XAI_API_KEY`) hanno rigenerato il dataset e la baseline solo-regole. La colonna Grok resta il segnaposto.

| Metrica | Prima di #44 | Dopo #44 |
| --- | --- | --- |
| Accuratezza di categoria | 4/19 | 4/19 |
| Step esatto | 3/19 | 4/19 |
| Step entro ±1 | 10/19 | 10/19 |
| Hit del fix proposto | 4/7 | 4/7 |
| Hint dell'iniettore | 13/19 | 0/19 |

Nessuna delle 19 trace contiene ancora un marker (`dropped_message`, `injector_skipped`, `injector_missed_target`, `forged_true`, `stale_true`, `injected_true`). Lo step esatto passa da 3/19 a 4/19 perché in `t1-verification-skip-product` l'etichetta e il finding `false_success_claim` cadono sullo stesso step: lo skip non inserisce più lo step di sistema `Injector skipped`.

## Ground truth

Categoria e step vengono dall'unica voce di `fault.labels`. Se `fault.attacker.used` è true, la fonte dichiarata nel manifest è `fault.attacker`: ADR-002 assegna quell'etichetta all'attaccante, e l'oggetto non porta una categoria. Il valutatore legge `fault` dopo i metodi. `diagnoseTrace` non lo mette nel prompt.

`timeout-repeated-tool-trace.json` e `tool-error-trace.json` restano fuori dal set. Una trace pulita non può avere `fault.labels`.

## Baseline solo-regole

La baseline è `diagnosisFindings` in `apps/agentservice` (il pre-pass della diagnosi, PR #29). ADR-002 lo distingue dal pre-pass dell'harness in `apps/backend/src/verifier/prepass.ts`. Il runner sta accanto a `diagnoseTrace` così non esiste una seconda copia dei finding.

Vince il primo finding, in quest'ordine:

| Finding | Categoria | Fix proposto |
| --- | --- | --- |
| `false_success_claim` | Verification | `pre_response_check` |
| `tool_error` | Execution | `controlled_retry` |
| `repeated_tool_call` | Reasoning | nessuno |
| `timeout` | Execution | `controlled_retry` |

Senza finding il metodo si astiene. L'astensione resta nel denominatore e conta come errore.

## Metriche

- **Accuratezza di categoria.** La categoria predetta è uguale all'unica categoria in `fault.labels`.
- **Step esatto.** Lo `step_id` predetto è uguale a quello dell'etichetta.
- **Step entro ±1.** La differenza assoluta di `step.index` è al massimo 1, incluso l'esatto. Uno `step_id` assente dalla trace è un errore.
- **Hit del fix proposto.** `proposed_fixes` contiene il fix ADR-002 della categoria etichettata: Execution → `controlled_retry`, Verification → `pre_response_check`, Security → `permission_guard`. Plan, ToolUse, Context e Reasoning non hanno un fix MVP e non entrano nel denominatore. Un fix in più non annulla l'hit. Non è il delta del verificatore dopo il replay ([#15](https://github.com/mesagroup/MESA-AgentFailureLab/issues/15), ADR-001).
- **Latenza, token, costo.** Una sola passata. Il timer avvolge `rulesBaseline` o `diagnoseTrace` dopo il caricamento della trace. Token e `cost_usd` sono quelli del provider. Se l'usage manca, il valore resta assente. I token non diventano un prezzo.

## Limiti

Il dettaglio con i conteggi è la sezione «Limiti noti» del README, riscritta da `pnpm eval`.

- I marker dell'iniettore (PR #28) stavano negli step e arrivavano a Grok: 13/19 trace prima della [PR #44](https://github.com/mesagroup/MESA-AgentFailureLab/pull/44). Quella PR (@diamanti-sg) non li copia più. Sul dataset rigenerato il conteggio è 0/19. Questo eval non modifica `apps/backend`.
- Il driver scriptato copre i fault del catalogo sulla sequenza T1–T5. La varietà di un agent che sceglie da solo lo strumento sbagliato arriva con la PR #21.
- L'efficacia del fix è il replay verificato di #15, non la riga «hit del fix proposto».
- ADR-001 lascia fuori l'aggregazione multi-run. Qui la passata è una.
- Senza `XAI_API_KEY` il costo di Grok è assente. La baseline solo-regole non ha token né costo.
