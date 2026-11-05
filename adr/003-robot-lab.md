# ADR 003 · Isolated robot experiments

The warehouse tests indirect instructions arriving as decoded QR text. Grok chooses one tool per turn. The backend keeps authoritative world state per request. Only a physical drop ends delivery. The generic experiment loop accepts an environment-specific observation, permission check, executor and verifier. A second test uses the shop T5 juror note and read grant. The shop runtime and data stores are independent.

## Enable or remove the surface

Set `FEATURES.robotLab` in `packages/shared/src/robot-lab.ts` (default `false`). Rebuild the workspace with `pnpm build` and redeploy frontend, backend and agentservice together. False removes the menu and lazy page bundle, redirects direct page visits to the dashboard, and leaves both POST routes unregistered. When enabling, deploy agentservice and backend before the frontend. When disabling, roll out the frontend first. Older browser tabs may need a reload.

## Rehearse

With the flag enabled and the existing agentservice xAI configuration set, open **Robot Lab**. Run the four buttons from left to right and download the JSON before leaving the page. Compare delivered/misdelivered, unauthorized drop attempts and blocked drops. The guard combines an instruction about provenance with a deterministic delivery permission. A model that ignores the injected instruction can pass both attack arms. A blocked action alone does not prove mission completion.

Each arm starts fresh and allows eight decisions over a 90-second harness budget, with one run per backend process. The simulator uses named docks and a decoded-text sensor. Grok usage is reported when the provider supplies it. An unavailable model yields an incomplete report; a run never substitutes scripted actions. The UI keeps this session's evidence in memory. Multiple instances have independent limits.
