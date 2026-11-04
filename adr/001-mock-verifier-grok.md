# ADR-001 — Confini mock / verificatore / Grok

- **Stato:** proposto (freeze team Backend+Architect; commit su E1)
- **Data:** 2026-11-04
- **Contesto:** Track 03 Agent Failure Lab / CHAOS.AI — Grok essenziale ma non prova causale; fix contano solo dopo replay verificato.

## Decisione

Tre componenti con responsabilità esclusive.

### 1. Mock e-commerce
- Unica fonte di verità dello *stato del mondo* (catalogo, carrello, ordini, permessi utente).
- API ispezionabile: il verificatore legge stato via endpoint/query dedicati, non tramite LLM.
- L’attaccante e l’agent di riferimento operano solo tramite tool/API del mock.
- Nessuna auth stub in MVP.

### 2. Verificatore deterministico
- Unica autorità sull’**esito** di una run (`outcome.verifier`).
- Input: `task_id` + `success_test.checks` + `mock_state_snapshot` (e/o lettura live del mock).
- Output: `passed`, lista `checks[]`, snapshot.
- **Non** usa Grok. **Non** interpreta trace narrative.
- Confronta baseline vs after_fix solo su questi check (+ timings/costs da Trace.totals).

### 3. Grok (diagnosi + proposte fix)
- Legge Trace (+ eventuale pre-pass regole: loop, timeout, tool ripetuti).
- Scrive solo in `diagnosis`: `category`, `cause`, `step_id`, `confidence`, `evidence[]`, `proposed_fixes[]`.
- **Non** scrive `outcome.verifier` né `fault.labels`.
- Fix applicati dall’harness; validità = replay + verificatore, non fiducia nella diagnosi.

## Ground truth
- `fault.labels` e `attacker`: solo iniettore / attaccante in run di caos.
- Eval classificazione: confronto `diagnosis.category` (+ step) vs `fault.labels`.
- Eval fix: delta `verifier.passed` e regressioni su altri task, non “Grok dice ok”.

## Run vs Trace
- **Trace:** steps, totals, fault, outcome.verifier, diagnosis.
- **Run (harness):** `phase` (`baseline|injected|after_fix`), `injection_plan`, `fix_kinds`, `trace_ids`. Non sono campi di Trace.

## Conseguenze
- Frontend timeline = Trace; before/after = Run + verifier.
- OpenAPI mock può `$ref` JSON Schema in `/packages/shared`; SoT schemi = JSON Schema, non OpenAPI.
- Fuori MVP: auth, aggregazione multi-run, LLM-as-judge sull’esito.

## Stato e proposta per il team (issue #101)

Lo **stato resta proposto**. Il runtime su `main` già rispetta i confini sopra (verificatore su `outcome.verifier`, iniettore/attaccante su `fault.*`, Grok solo su `diagnosis`, persistenza della diagnosi via `POST /traces/:traceId/diagnose` nelle PR #98/#102). Questa issue **non** marca ADR-001 come accettato.

Proposta da votare in team, senza effetto finché non c’è consenso:

- passare lo stato a **accettato** se i tre confini e la ground truth di questa ADR restano la regola;
- lasciare **proposto** se si vuole un freeze formale successivo, dopo la prova live autorizzata.

Non è un’accettazione implicita. Non cambia ADR-002.

## Allineamento giuria (Track 03)
- Accuratezza classificazione su GT annotate / iniettore.
- Precisione step.
- Spiegazioni verificabili (evidence → step_id).
- Fix efficaci senza regressioni evidenti; costo aggiuntivo misurato.
- Fuori scope: diagnosi Grok come prova causale senza esperimento.
