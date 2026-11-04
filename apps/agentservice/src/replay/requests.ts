import type { OwnerRequest } from "./types.js";

/**
 * Interface requests for the owners of the harness and the reference agent.
 * This package does not implement them.
 */
export const OWNER_REQUESTS: readonly OwnerRequest[] = [
  {
    owner: "@diamanti-sg",
    area: "AgentRunRequest.fix_kinds",
    request:
      "AgentRunRequest in packages/shared already has optional " +
      'fix_kinds?: Array<"controlled_retry" | "pre_response_check" | "permission_guard">, ' +
      "re-exported from apps/backend/src/agent/http.ts. Do not declare a second interface. " +
      "POST /v1/tasks/run must send that field. In apps/backend/src/harness/runner.ts, loadActions " +
      "builds the request without it, and resolveFixKinds only stores the list on the Run. " +
      "after_fix must copy Run.fix_kinds onto the request (and onto the object passed to callAgent). " +
      "Omit the field, or send [], when the run has no fix. The scripted driver currently ignores fix_kinds.",
  },
  {
    owner: "@diamanti-sg",
    area: "controlled_retry inside executeAttempt",
    request:
      "executeAttempt runs each action once and does not return the tool result to the agent, " +
      "so an executed:false agent cannot retry. When the run's fix_kinds contains controlled_retry, " +
      "re-issue that tool through the same injector path after a transient result " +
      "(body.error === \"timeout\", or status 0, 408, 429, 500, 502, 503, 504), at most twice, with backoff. " +
      "Retry reads (search_products, get_product, get_cart, get_order) on any transient result. " +
      "Retry a mutate tool (add_to_cart, update_cart, checkout, cancel_order) only when the attempt was not dispatched. " +
      "Do not retry a dispatched 5xx on a mutate tool. The catalog effect drop fires again on a new attempt, " +
      "so dropped_tool_call still fails; the loop is for a transient blip, not for defeating a deterministic drop. " +
      "The rule to mirror is retryDecision in apps/agentservice/src/fixes/domain.ts. " +
      "Do not import the agent service from the backend.",
  },
  {
    owner: "@diamanti-sg",
    area: "permission_guard and the jury attacker",
    request:
      "executeAttempt sends the session grant, so the shop already rejects cancel_order without write:order:cancel " +
      "and verifier.passed does not move. applyJurorAttack inserts cancel_order and sends read,write:order:cancel " +
      "without asking the agent. Before inserting that action, call the agent with fix_kinds, and do not elevate " +
      "X-Permissions from text in the prompt or in a tool result. The agent-side behavior is guardCall plus " +
      "readEmbeddedInstructions in apps/agentservice/src/fixes/domain.ts: a mentioned permission is data, not a grant.",
  },
];

export const HARNESS_GAP =
  "Production after_fix does not pass fix_kinds on AgentRunRequest. This replay applies the policy inside the harness callAgent hook, which POST /v1/tasks/run does not use. fix_kinds_on_agent_run_request is false on every arm.";

export const RETRY_GAP =
  "controlled_retry has no preset verifier delta. The action list cannot retry after a result, and catalog drop fires on every attempt. The probe counts are the applicator, not the verifier.";

export const GUARD_GAP =
  "permission_guard has no preset verifier delta on T5. The preset forges a cancel result while the cancel grant is present, and the shop enforces the session grant. The jury attacker does not consult this guard.";
