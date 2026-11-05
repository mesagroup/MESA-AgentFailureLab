# Documentation

Product and contributor docs live here. Architecture Decision Records do not — those are in [`adr/`](../adr/README.md).

- [Overview](overview.md) — what the lab is, what is implemented, and Track 03
- [Agent tasks](agent-tasks.md) — `AgentTask` setup, check registry, and an example
- [OpenTelemetry import](otel.md) — source on the agent, span mapping, shop schema A, library schema B, mock HTTP pull, and the boundary with production import (#51)
- [Canonical shop scenario](../apps/agentservice/scenarios/shop-readback-v1/README.md) — #99 fixture, isolated HTTP experiment, negative controls and handoff to #100
- [Shop experiment command](shop-experiment.md) — #100 HTTP pipeline, explicit offline/live modes, evidence reports and exit codes
- [Architecture](architecture.md) — six HTTP processes; shop and library mocks are stand-alone HTTP targets
- [Persistence](persistence.md) — Agent, Run, and Trace stores (Postgres or memory), migrations, APIs, backup, jury reset, cutover, and the local runbook
- [Getting started](getting-started.md) — install, run one app, where each team writes code
- [Demo script](demo-script.md) — end-to-end demo, [jury shop runbook (azione A)](demo-script.md#runbook-giuria), video storyboard
- [Jury demo](demo-jury.md) — security case (step 8 of the product walkthrough) and the [frontend contract](demo-jury.md#frontend-contract-issue-55) for issue #55; not the shop experiment command
- [Eval](eval.md) — dataset, metrics, rules-only baseline, limits (Italian, for the jury)
- [Deploy](deploy.md) — Docker images, Compose, Render project `mesa-agent-failure-lab` / `demo`, secrets
- [Seed endpoints](seed-endpoints.md) — `reference-shop` and `external-library` runtime and mock URLs per environment
