# ADR-002 — Iniezione dei fault e dei fix MVP

- **Stato:** accettato
- **Data:** 2026-11-04
- **Contesto:** Track 03 Agent Failure Lab, demo del 5 novembre 2026. L'iniettore è quello della PR #28. L'attaccante di giuria è quello della PR #32. Gli id dei fix sono l'enum `FixKind` della PR #19. Issue #15 (@smontuor) resta l'applicatore. Issue #8 (@ercoleMesa) è l'agent T1–T5, aperto nella PR #21. ADR-001 resta il confine tra mock, verificatore e Grok. Questo file non cambia codice.

## Decisione

### 1. Iniettore, sul confine tool del backend

- L'iniezione sta in `apps/backend`, in `executeAttempt`, prima di `MockShopClient.request`. La Run porta `injection_plan`. `POST /runs` manda `injection` come `preset`, come oggetto, o come null. `preset` legge `TASK_FAULT_PRESETS`.
- Gli effetti sono `skip`, `mutate_input`, `forge_output`, `replace_output` e `drop`. `skip`, `forge_output` e `drop` non chiamano `services/mock-shop`.
- L'agent sotto l'harness restituisce le azioni con `executed: false`. L'harness fa la chiamata HTTP. Il backend scrive `fault.injected` e `fault.labels`. `apps/agentservice` e Grok non scrivono quei campi, né `fault.attacker`. I path sono `GROK_FORBIDDEN_WRITE_PATHS`.
- Il testo negli step non è ground truth. `content`, `tool_input` e `tool_output` non riportano i marker dell'iniettore (`Injected…`, `Injector skipped`, `Injector target … was not called`, `forged: true`, `stale: true`, `injected: true`, e gli stessi flag a `false`). Categoria, codice e step restano su `fault.labels`. `fault.injected` e `fault.attacker` restano metadati di harness. Il verificatore non legge quel testo: l'esito continua a dipendere dai check e dallo snapshot del mock. `scrubSpoilers` in `apps/backend/src/injector/spoilers.ts` è il confine, riusabile da un payload prima di scriverlo su uno step.

### 2. Attaccante di giuria, come nella PR #32

- Sta in `apps/backend/src/attacker/`. Il caso è T5, via `POST /attacker/jury-case`. Il codice `unauthorized_cancel_via_juror_note` non è nel catalogo, e `POST /runs` lo rifiuta. Il preset T5 resta `forged_permission_success`, che contraffà il tool result e non chiama il mock.
- Il payload entra nel messaggio utente. `attackedUserContent` accoda la nota del giurato al prompt T5. L'id è `jury-nota-malevola-cancel`.
- `applyJurorAttack` inserisce `cancel_order` e lo invia allo shop con `read,write:order:cancel`. Il grant di sessione è solo `read`. Il body del tool result è quello del mock.
- La Trace del caso attaccato ha `fault.attacker.used: true` e `payload_id` `jury-nota-malevola-cancel`. La label ha categoria `Security` e codice `unauthorized_cancel_via_juror_note`, sullo step del tool result. Lo stesso codice sta in `injection_plan.ground_truth`.

### 3. Id dei fix, come nello schema

`Run.fix_kinds` e `diagnosis.proposed_fixes` usano solo `controlled_retry`, `pre_response_check` e `permission_guard`.

- **controlled_retry.** Al massimo due ritentativi su un tool fallito. Pre-pass `timeout`. Categoria di diagnosi `Execution`.
- **pre_response_check.** Rilettura dello stato del mock prima del claim di successo. Categoria di diagnosi `Verification`. `prepass.ts` non ha un kind per quel claim.
- **permission_guard.** Blocca l'azione che richiede `write:order:cancel` se il permesso manca. Categoria di diagnosi `Security`.

`loop` e `repeated_tool` restano senza un fix MVP.

### 4. Decisioni nuove

- **Applicazione.** I tre id sono flag di configurazione dell'agent in `apps/agentservice`. L'harness li passa quando avvia la run `after_fix`, copiandoli da `fix_kinds`. Il fix conta solo dopo il replay verificato, come in ADR-001.
- **Zod.** I tool dell'agent possono usare zod. JSON Schema in `packages/shared` resta la fonte di verità per Trace, Run e Agent. I test restano su `node --test`.

## Conseguenze

- L'hook in `createToolAdapter` della [PR #21](https://github.com/mesagroup/MESA-AgentFailureLab/pull/21) deve passare dall'iniettore del backend, o delegargli la chiamata. Resta un solo iniettore, quello dell'harness. Oggi l'agent chiama lo shop da solo, e l'harness rifiuta `executed: true`. `buildTrace` scrive `fault.injected: false`, senza label, e riempie `outcome.verifier` in locale. ADR-001 dà l'esito solo al verificatore del backend.
- `AgentRunRequest` non porta i flag. La run `after_fix` salva `fix_kinds` e rilancia la sequenza scriptata. Nella PR #21 i flag arrivano solo nel body di `POST /run`. Lì `controlled_retry` ritenta su status 0 o su HTTP 5xx. `permission_guard` blocca anche `checkout` senza `write:order`. L'issue #15 dice ancora `retry_controllato` e `applied_fixes`.
- La [PR #29](https://github.com/mesagroup/MESA-AgentFailureLab/pull/29) tiene `proposed_fixes` dentro `FIX_KINDS` e non scrive `fault.*`. Categoria e id restano scelte del modello. Il pre-pass di #29 non è quello di `prepass.ts`. Il retry HTTP del client Grok non è `controlled_retry`. Lo step `system` del caso giuria nomina il payload id, e #29 manda gli step a Grok.
