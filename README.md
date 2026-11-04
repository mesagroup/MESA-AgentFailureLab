# MESA Agent Failure Lab

Monorepo for Track 03 — Agent Failure Lab / CHAOS.AI. Frontend, Backend, and the AI Engineer each get an app. Contracts, product docs, and architecture decisions sit outside those apps.

CHAOS.AI / Agent Failure Lab is a generic lab: register an agent, test it with injected faults, inspect the trace, and get a diagnosis and proposed fixes. A fix counts after the harness replays it and the deterministic verifier agrees. The same loop is planned for production traces and for opening a GitHub issue from a diagnosis. The mock shop and the shopping agent (tasks T1–T5) are the demo example. The demo shop is its own HTTP server. The harness and the agent service call it by URL. Product boundaries, and what is still planned: [docs/overview.md](docs/overview.md). Runtime: [docs/architecture.md](docs/architecture.md). Freeze: [ADR-001](adr/001-mock-verifier-grok.md). Narrative: [racconto v2](https://cursor.com/canvas/store-dd8d0140-8ad3-43f8-94aa-372bb19c176d/0ad71f2e-bbbc-444f-aab0-7bf91b830aae).

## Monorepo map

```
/
  apps/
    frontend/        # web UI scaffold — Agent CRUD, Testa agente, Ispeziona traccia are planned
    backend/         # harness, verifier, injector, in-memory Run/Trace persistence
    agentservice/    # Grok diagnosis, MVP fixes, reference demo agent (T1–T5)
  services/
    mock-shop/       # demo HTTP shop for T1–T5; external target via URL, port 8787
  packages/
    shared/          # JSON Schema + TypeScript contracts (Trace, Agent, Run)
  docs/              # product and contributor docs (not ADRs)
  adr/               # Architecture Decision Records only
  package.json
  turbo.json
  pnpm-workspace.yaml
```

| Path | Team | Owns |
| --- | --- | --- |
| [`apps/frontend`](apps/frontend/README.md) | Frontend | Scaffold today. Planned: Agent CRUD, Testa agente, Ispeziona traccia. The timeline will render `Trace`. Before/after will use `Run` + `outcome.verifier`. |
| [`apps/backend`](apps/backend/README.md) | Backend | Harness phases, deterministic verifier, labeled injector, security attacker, in-memory Run/Trace persistence. No auth. No Agent CRUD API yet. |
| [`services/mock-shop`](services/mock-shop/README.md) | Backend | Demo example: stand-alone external HTTP shop on port 8787. Catalog, cart, checkout, cancel, `GET /internal/state`. The harness calls `MOCK_SHOP_URL`. Own process, separate from the harness. |
| [`apps/agentservice`](apps/agentservice/README.md) | AI Engineer | Reference demo agent proposes T1–T5 actions (`executed: false`). Grok diagnosis writes `diagnosis` only. MVP fixes: `controlled_retry`, `pre_response_check`, `permission_guard`. |
| [`packages/shared`](packages/shared/README.md) | All | Shared contracts. JSON Schema is the source of truth for Trace, Agent, and Run. |
| [`docs/`](docs/README.md) | All | Overview, runtime architecture, and contributor guide. |
| [`adr/`](adr/README.md) | Architect | Numbered ADRs, separate from `docs/`. |

## Install and run

Requires Node.js 22.12+ and pnpm 10.33.4 (`packageManager` in `package.json`).

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

`pnpm build` runs `turbo run build` for `@mesa/shared`, the three apps, and `@mesa/mock-shop`.

Run the app you own:

```bash
pnpm exec turbo run dev --filter=@mesa/frontend      # http://127.0.0.1:3000
pnpm exec turbo run dev --filter=@mesa/backend       # http://127.0.0.1:3001  GET /health
pnpm exec turbo run dev --filter=@mesa/agentservice  # http://127.0.0.1:3002  GET /health
pnpm exec turbo run dev --filter=@mesa/mock-shop     # http://127.0.0.1:8787  GET /health
```

Shortcuts: `pnpm dev:frontend`, `pnpm dev:backend`, `pnpm dev:agentservice`, `pnpm dev:mock-shop`. `pnpm dev` starts every dev script.

## Dataset e risultati

Il dataset qui sotto è l'esempio demo (shop e task T1–T5). Il prodotto è il lab generico, in [docs/overview.md](docs/overview.md). Il testo fra i marcatori è l'output di `pnpm eval` (definizioni, provenienza, tabella del baseline solo-regole). Non va ricopiato a mano. Spiegazione: [docs/eval.md](docs/eval.md). Matrice di confusione e righe per trace: [apps/agentservice/eval/results/latest.md](apps/agentservice/eval/results/latest.md).

```bash
pnpm generate-dataset
pnpm eval
```

Con `XAI_API_KEY` impostata, lo stesso `pnpm eval` sostituisce il segnaposto della colonna Grok. `pnpm eval:gate` riesegue solo il baseline deterministico, ignora `XAI_API_KEY`, e confronta le quattro frazioni della colonna Baseline con [`apps/agentservice/eval/baseline.json`](apps/agentservice/eval/baseline.json). La soglia `max_rate_drop` è in quel file. Dettaglio: [docs/eval.md](docs/eval.md).

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

> **Colonna Grok — live** (`grok-3`), una passata. Errori nel denominatore: 0.

| Metrica | Baseline (solo regole) | Grok |
| --- | --- | --- |
| Accuratezza di categoria | 4/19 | 5/19 |
| Step esatto | 5/19 | 5/19 |
| Step entro ±1 | 10/19 | 13/19 |
| Hit del fix proposto | 4/7 | 7/7 |
| Fix non applicabile | 12 | 12 |
| Latenza media (ms) | 0.042 | 9852.200 |
| Token in/out | n/a | 19746/1339 |
| Costo USD | n/a | 0.045721 |
<!-- eval-scoreboard:end -->

## Limiti noti

<!-- eval-limits:start -->
- Hint dell'iniettore in 0/19 trace. Prima della [PR #44](https://github.com/mesagroup/MESA-AgentFailureLab/pull/44) erano 13/19: i marker negli step (`Injected execution drop…`, `Injector skipped`, `forged: true`, `stale: true`, `injected: true`) arrivavano a Grok. Quella PR (@diamanti-sg) non li copia più. Questo eval non modifica `apps/backend`.
- Il driver scriptato dà poca varietà finché non entra l'agent di riferimento ([PR #21](https://github.com/mesagroup/MESA-AgentFailureLab/pull/21)). `pnpm generate-dataset` non copia quell'agent.
- L'efficacia del fix richiede il replay del verificatore ([#15](https://github.com/mesagroup/MESA-AgentFailureLab/issues/15)). La riga del fix nella tabella dice solo se la proposta contiene il fix ADR-002 della categoria etichettata.
- Una sola passata (conteggio: 1). ADR-001 esclude l'aggregazione multi-run.
- Costo Grok riportato dal provider: 0.045721 USD (totale), token in/out 19746/1339. La baseline solo-regole non riporta token né costo.
<!-- eval-limits:end -->

Copy an app's `.env.example` to `.env` only when you need overrides. Do not commit `.env` or a Grok API key. `XAI_API_KEY` in `apps/agentservice/.env.example` is an empty placeholder.

## Docker and Render

Four images, built from the repo root so the workspace is in the context:

```bash
docker build -f apps/frontend/Dockerfile -t mesa-frontend .
docker build -f apps/backend/Dockerfile -t mesa-backend .
docker build -f apps/agentservice/Dockerfile -t mesa-agentservice .
docker build -f services/mock-shop/Dockerfile -t mesa-mock-shop .
docker compose up --build
```

| Image | Port | Health |
| --- | --- | --- |
| `mesa-frontend` | 3000 | `GET /health` |
| `mesa-backend` | 3001 | `GET /health` |
| `mesa-agentservice` | 3002 | `GET /health` |
| `mesa-mock-shop` | 8787 | `GET /health` |

Containers listen on `0.0.0.0`. `pnpm dev` still binds `127.0.0.1`. Compose publishes the ports above on a shared network (`mesa-frontend`, `mesa-backend`, `mesa-agentservice`, `mesa-mock-shop`) and sets the harness `MOCK_SHOP_URL` to `http://mesa-mock-shop:8787`. The Render Blueprint groups the same four free Frankfurt services in project `mesa-agent-failure-lab`, environment `demo`. The shop stays its own service. Env vars, `XAI_API_KEY`, and the Dashboard apply steps: [docs/deploy.md](docs/deploy.md).

## Docs

- [Overview](docs/overview.md) — generic lab, demo shop, implemented vs planned
- [Architecture](docs/architecture.md) — stand-alone mock shop, ports, ADR-001 writers, Render
- [Getting started](docs/getting-started.md) — contributor workflow and stack choices
- [Jury demo](docs/demo-jury.md) — one security case, baseline comparison, limitations
- [Eval](docs/eval.md) — dataset, metriche, baseline solo-regole, limiti
- [Deploy](docs/deploy.md) — Docker, Compose, Render Blueprint, secrets
- [ADRs](adr/README.md) — decisions only; [ADR-001](adr/001-mock-verifier-grok.md) is the mock / verifier / Grok freeze

## Contracts

`packages/shared` exports the frozen shapes. `outcome.verifier` is the only pass/fail authority. `diagnosis` stays null until Grok writes it, and Grok must not write `outcome.verifier` or `fault.labels`.

- **Trace** — steps, per-step timings and costs, totals, `outcome.verifier`, fault labels, `diagnosis`
- **Agent** — instance, test instance, trace store, docs, tasks with `verifier_checks`. Any non-empty task list is valid. The reference stub is the shopping demo and has T1–T5.
- **Run** — harness metadata (`phase` is `baseline`, `injected`, or `after_fix`; plus `injection_plan`, `fix_kinds`, `trace_ids`), not nested in Trace

Hand-written T2, T3, and T5 traces are in `packages/shared/examples` and use the injector catalog codes. The reference demo agent is `POST /v1/tasks/run` on port 3002. The harness owns tool execution and `outcome.verifier`.
