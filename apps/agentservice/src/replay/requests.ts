import type { OwnerRequest } from "./types.js";

/**
 * Notes kept on the replay report after the harness requests landed.
 * This package does not implement the harness.
 */
export const OWNER_REQUESTS: readonly OwnerRequest[] = [
  {
    owner: "@diamanti-sg",
    area: "AgentRunRequest.fix_kinds",
    request:
      "Landed on the shared AgentRunRequest in @mesa/shared. after_fix copies Run.fix_kinds onto that request and onto the object passed to callAgent. Baseline and injected runs omit the field. The scripted action planner still ignores fix_kinds. The backend does not declare a second interface.",
  },
  {
    owner: "@diamanti-sg",
    area: "controlled_retry inside executeAttempt",
    request:
      "Landed. When fix_kinds contains controlled_retry, executeAttempt re-issues a transient tool on the same injector path, at most twice, with backoff. Reads retry any transient result. A mutate tool retries only when the attempt was not dispatched. A catalog drop still fires on every attempt.",
  },
  {
    owner: "@diamanti-sg",
    area: "permission_guard and the jury attacker",
    request:
      "Landed. The jury path calls the agent with fix_kinds before cancel_order and does not elevate X-Permissions from prompt or tool text. With the grant absent and permission_guard on, the agent refuses and the client is not called. Guard off is the documented baseline: the shop rejects the cancel. This is not the #17 UI jury round.",
  },
];

export const HARNESS_GAP =
  "after_fix copies Run.fix_kinds onto AgentRunRequest. fix_kinds_on_agent_run_request is true on those arms and false when the run stores no fix. The scripted action planner still ignores the field; controlled_retry is applied in executeAttempt.";

export const RETRY_GAP =
  "Catalog drop still fires on every attempt of the targeted tool, so dropped_tool_call does not flip the preset verifier. controlled_retry covers a transient blip inside executeAttempt. The probe counts remain the applicator, not that preset.";

export const GUARD_GAP =
  "permission_guard still has no preset verifier delta on T5. The preset forges a cancel result while the cancel grant is present. The jury path now asks the agent and does not widen X-Permissions; with the guard on and the grant absent the client is not called. That check is not the #17 UI jury round.";
