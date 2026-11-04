# Documentation

Product and contributor docs live here. Architecture Decision Records do not — those are in [`adr/`](../adr/README.md).

- [Overview](overview.md) — what the lab is, and Track 03
- [Agent tasks](agent-tasks.md) — `AgentTask` setup, check registry, and an example
- [Canonical shop scenario](../apps/agentservice/scenarios/shop-readback-v1/README.md) — #99 fixture, isolated HTTP experiment, negative controls and handoff to #100
- [Architecture](architecture.md) — four processes; mock-shop is a stand-alone HTTP target
- [Persistence](persistence.md) — Agent, Run, and Trace stores (Postgres or memory), migrations, APIs, backup, jury reset, cutover, and the local runbook
- [Getting started](getting-started.md) — install, run one app, where each team writes code
- [Demo script](demo-script.md) — end-to-end demo and manual test steps, video storyboard (umbrella for the jury demo)
- [Jury demo](demo-jury.md) — security case (step 8) and the [frontend contract](demo-jury.md#frontend-contract-issue-55) for issue #55
- [Eval](eval.md) — dataset, metrics, rules-only baseline, limits (Italian, for the jury)
- [Deploy](deploy.md) — Docker images, Compose, Render project `mesa-agent-failure-lab` / `demo`, secrets
