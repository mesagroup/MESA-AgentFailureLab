# Fix: Runs show launch prompt override

## Plan
- [x] Prefer `run.prompt` over catalog `task.prompt` in `taskViewFor` / run detail
- [x] Runs list preview + filter use the same effective prompt
- [x] Tests for override; run FE run-detail tests
- [x] Review notes

## Review
- Root cause: UI read `task.prompt` from the agent catalog; launch overrides are stored on `Run.prompt`.
- Fix: `effectiveRunPrompt(run, agent)` — non-empty `run.prompt` wins; else catalog fallback (legacy runs).
- Wired into run detail (`taskViewFor`) and Runs list preview/filter.
- Tests: `run-detail.test.ts` 13/13 pass.
