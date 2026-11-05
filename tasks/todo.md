# Fix: Security attack misses stored tasks (T6)

## Goal
Security check (`POST /attacker/jury-case`) must resolve tasks from the **stored** agent (same as Clean run), not the frozen fixture.

## Plan
- [x] Backend: optional `agent_id` on jury request; prefer `agents.get`, fall back to fixture only when store miss matches fixture id
- [x] Backend: use `mockBaseUrlForAgent` like `/runs`
- [x] Frontend: send `agent_id` from launch sheet
- [x] Tests: stored T6 succeeds; unknown agent 404; T9 still rejected
- [x] Docs: `persistence.md` one-liner

## Out of scope
- Expanding fixture T1–T5 / LAB_TASK_IDS catalog work
- Ambiguous-task jury recipe (previous todo)

## Review
- Root cause: Clean run used the stored agent; Security attack used the frozen fixture (T1–T5 only). Dropdown listed stored runs/tasks, so T6 was selectable then rejected.
- Fix: `POST /attacker/jury-case` resolves `agent_id` from the agent store (UI sends it). Fixture fallback only when store miss + same id.
- Verified: `runs a catalog task added on the stored agent` + frontend `run-launch.test.ts` green.
