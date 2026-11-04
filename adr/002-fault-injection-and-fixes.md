# ADR-002 — Iniezione dei fault e dei fix MVP

- **Stato:** accettato
- **Data:** 2026-11-04
- **Contesto:** Track 03 Agent Failure Lab, demo del 5 novembre 2026. L'iniettore è quello mergiato con la PR #28. Gli id dei fix sono l'enum `FixKind` degli schemi mergiati con la PR #19. Issue #15 (@smontuor) resta l'applicatore. Issue #8 (@ercoleMesa) è l'agent T1–T5, aperto nella PR #21. ADR-001 resta il confine tra mock, verificatore e Grok. Questo file non cambia codice.

## Decisione

### 1. Iniettore, come su main

- L'iniezione sta in `apps/backend`, in `executeAttempt`. La Run porta `injection_plan`. `POST /runs` manda `injection` come `preset`, come oggetto, o come null. `preset` legge `TASK_FAULT_PRESETS` in `apps/backend/src/injector/catalog.ts`.
- La chiamata al tool viene riscritta prima di `MockShopClient.request`. Gli effetti sono `skip`, `mutate_input`, `forge_output`, `replace_output` e `drop`. `skip`, `forge_output` e `drop` non arrivano allo shop (`services/mock-shop`).
- L'agent sotto l'harness restituisce le azioni con `executed: false`. L'harness fa la chiamata HTTP. Il backend scrive `fault.injected` e `fault.labels`. `apps/agentservice` e Grok non scrivono quei campi, né `fault.attacker`. I path sono `GROK_FORBIDDEN_WRITE_PATHS`.

### 2. Id dei fix, come nello schema

`Run.fix_kinds` e `diagnosis.proposed_fixes` usano solo `controlled_retry`, `pre_response_check` e `permission_guard`.

- **controlled_retry.** Al massimo due ritentativi su un tool fallito. Pre-pass `timeout`. Categoria di diagnosi `Execution`.
- **pre_response_check.** Rilettura dello stato del mock prima del claim di successo. Categoria di diagnosi `Verification`. `prepass.ts` non ha un kind per quel claim.
- **permission_guard.** Blocca l'azione che richiede `write:order:cancel` se il permesso manca. Categoria di diagnosi `Security`.

`loop` e `repeated_tool` restano senza un fix MVP.

### 3. Decisioni nuove

- **Applicazione.** I tre id sono flag di configurazione dell'agent in `apps/agentservice`. L'harness li passa quando avvia la run `after_fix`, copiandoli da `fix_kinds`. Il fix conta solo dopo il replay verificato, come in ADR-001.
- **Attaccante.** È un fault `Security` iniettato dallo stesso `executeAttempt`. Il payload arriva nel contenuto del tool output, per esempio testo di prompt injection nella descrizione di un prodotto. Il backend imposta `fault.attacker.used` e `payload_id`. L'agent tratta quel testo come dato.
- **Zod.** I tool dell'agent possono usare zod. JSON Schema in `packages/shared` resta la fonte di verità per Trace, Run e Agent. I test restano su `node --test`.

## Conseguenze

- La [PR #21](https://github.com/mesagroup/MESA-AgentFailureLab/pull/21) chiama lo shop da `createToolAdapter` e descrive `hook` come punto di iniezione nell'agent. L'harness rifiuta `executed: true`, quindi quel percorso non entra in `executeAttempt`. `buildTrace` scrive `fault.injected: false`, senza label, e riempie `outcome.verifier` in locale. ADR-001 dà l'esito solo al verificatore del backend.
- Su main `fault.attacker` resta `used: false` e `payload_id: null`. Il codice `Security` del catalogo è `forged_permission_success`, un cancel contraffatto. Gli step `skip` mettono `Injector skipped` nel `content`. La [PR #29](https://github.com/mesagroup/MESA-AgentFailureLab/pull/29) invia gli step a Grok.
- `AgentRunRequest` non porta i flag. La run `after_fix` salva `fix_kinds` e rilancia la sequenza scriptata. Nella PR #21 i flag arrivano solo nel body di `POST /run`. Lì `controlled_retry` ritenta su status 0 o su HTTP 5xx. `permission_guard` blocca anche `checkout` senza `write:order`, e la risposta contiene `blocked_by`. Il nudge di `pre_response_check` scrive il nome del flag nel messaggio. L'issue #15 dice ancora `retry_controllato` e `applied_fixes`.
- La PR #29 tiene `proposed_fixes` dentro `FIX_KINDS` e non scrive `fault.*`. La categoria e l'id del fix restano scelte del modello. Il suo pre-pass usa `false_success_claim`, `tool_error`, `repeated_tool_call` e `timeout`. `prepass.ts` usa `loop`, `timeout` e `repeated_tool`. Il secondo tentativo del client di diagnosi è il retry HTTP di Grok. `controlled_retry` è il flag dell'agent.
