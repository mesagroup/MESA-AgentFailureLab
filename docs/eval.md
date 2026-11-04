# Eval del dataset

Track 03 chiede un set etichettato e il confronto fra un baseline solo-regole e Grok. I numeri della tabella stanno nel README, fra i marcatori `eval-scoreboard` e `eval-limits`. Li scrive `pnpm eval`. Questo file spiega le definizioni e registra il confronto prima/dopo la [PR #44](https://github.com/mesagroup/MESA-AgentFailureLab/pull/44).

## Comandi

Dalla radice del repository:

```bash
pnpm generate-dataset
pnpm eval
pnpm eval:gate
```

`pnpm generate-dataset` avvia il mock shop in loopback e il driver `scripted` del harness già in main, con i fault del catalogo. Non chiama l'agent di riferimento della [PR #21](https://github.com/mesagroup/MESA-AgentFailureLab/pull/21). Una seconda esecuzione cambia gli id e i timestamp, perché l'harness usa `randomUUID` e `Date.now`.

`pnpm eval` legge il manifest `apps/agentservice/eval/dataset/manifest.json`, calcola il baseline solo-regole e, se `XAI_API_KEY` è impostata, chiama Grok. Senza chiave la colonna Grok resta il segnaposto. `pnpm eval -- --fake` usa un modello etichettato `fake-diagnosis` e non è un punteggio di Grok.

`pnpm eval:gate` riesegue solo il baseline deterministico. Passa a `resolveGrok` una chiave vuota: lo skip è quello di `pnpm eval` senza chiave, e una chiave già nel processo non viene usata. Il confronto e la soglia stanno in [Gate CI](#gate-ci).

Il report completo (confusione, hint per tipo, una riga per trace) è [apps/agentservice/eval/results/latest.md](../apps/agentservice/eval/results/latest.md).

## Gate CI

`.github/workflows/ci.yml` lancia `pnpm eval:gate` su ogni pull request e su `main`, dopo build e test. Il job non ha bisogno di `XAI_API_KEY`. Il comando passa a `resolveGrok` una env con la chiave vuota, lo stesso skip di `pnpm eval` senza chiave, e non apre un client live.

Il riferimento committato è [`apps/agentservice/eval/baseline.json`](../apps/agentservice/eval/baseline.json). `pnpm eval` non lo riscrive: quel comando aggiorna la scoreboard (README e `eval/results`), compresa la colonna Grok quando la chiave c'è. Il gate legge i quattro tassi della colonna «Baseline (solo regole)», gli stessi che la schermata [#57](https://github.com/mesagroup/MESA-AgentFailureLab/issues/57) deve prendere dall'output di `pnpm eval`:

| id | Riga della scoreboard |
| --- | --- |
| `category_accuracy` | Accuratezza di categoria |
| `step_accuracy_exact` | Step esatto |
| `step_accuracy_tolerance_1` | Step entro ±1 |
| `proposed_fix_hit_rate` | Hit del fix proposto |

La soglia è `threshold.max_rate_drop`, una frazione `numerator/denominator` nello stesso file. Con `0/1` il tasso fresco deve avere gli stessi `hits` e lo stesso `total` del file. Con una soglia positiva il job fallisce solo se il valore assoluto della differenza fra i due tassi è maggiore della soglia: una differenza uguale passa. Latenza, token, costo e la colonna Grok restano fuori, perché la latenza del baseline solo-regole cambia fra un processo e l'altro e senza chiave Grok non ha un punteggio.

Su main attuale le frazioni del file sono quelle del baseline solo-regole, quindi il job è verde.

Per vedere il rosso si abbassa il baseline. In `category_accuracy`, portare `hits` da 4 a 3 e lanciare `pnpm eval:gate`: il processo esce 1. Ripristinare il file dopo la prova. Senza modificarlo:

```bash
pnpm eval:gate -- --simulate-drop category_accuracy
```

Quel flag toglie un hit al tasso fresco e termina con codice 1. Il workflow non lo passa.

Quando il metodo solo-regole cambia e i nuovi tassi sono quelli da tenere, aggiornare scoreboard e file insieme:

```bash
pnpm eval
pnpm eval:gate -- --write
```

`--write` sostituisce i conteggi. Descrizione e `max_rate_drop` restano quelli del file.

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
