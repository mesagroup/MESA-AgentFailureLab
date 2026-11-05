/**
 * Time budgets and runtime labels for the single-shot Grok planner.
 * Scripted runs do not read these numbers.
 *
 * One Grok 4.6 tool-calling turn is often 10–60s. Render's public proxy
 * closes a response that runs about 100s, so a model call stays inside 90s
 * and is not given a second full window. The browser does not hold that
 * call: the harness answers 202 and the page polls.
 */

export const GROK_MODEL_ID = "grok-4.6";

export const GROK_REASONING_EFFORT = "medium" as const;

/** One xAI tool-calling HTTP call. */
export const GROK_MODEL_TIMEOUT_MS = 90_000;

/**
 * Backend → agentservice fetch when the body asks for the grok planner.
 * Shorter than Render's public proxy so the response can still be read.
 */
export const GROK_AGENT_HTTP_TIMEOUT_MS = 95_000;

/** One jury case or one lab task: the model call plus the shop calls after it. */
export const GROK_RUN_TIMEOUT_MS = 180_000;

/** The security attacker may take up to three sequential model attempts. */
export const GROK_ATTACKER_ATTEMPTS = 3;

export const GROK_ATTACKER_ATTEMPT_TIMEOUT_MS = GROK_MODEL_TIMEOUT_MS;

export const GROK_ATTACKER_TOTAL_TIMEOUT_MS = GROK_ATTACKER_ATTEMPTS * GROK_ATTACKER_ATTEMPT_TIMEOUT_MS;

/**
 * Harness clock for an attacker run. The model budget is three full attempts;
 * the extra 30s is shop time after the last attempt so the tool loop is not
 * marked timed out on the boundary.
 */
export const GROK_ATTACKER_HARNESS_TIMEOUT_MS = GROK_ATTACKER_TOTAL_TIMEOUT_MS + 30_000;

/** Verify fix is budgeted as up to three sequential runs, each with its own clock. */
export const GROK_FIX_RUNS = 3;

export const GROK_FIX_RUN_TIMEOUT_MS = GROK_RUN_TIMEOUT_MS;

export const GROK_FIX_TOTAL_TIMEOUT_MS = GROK_FIX_RUNS * GROK_FIX_RUN_TIMEOUT_MS;

/** Page poll while a grok job runs in the background. Each GET is short. */
export const GROK_POLL_INTERVAL_MS = 2_000;

export const GROK_POLL_REQUEST_TIMEOUT_MS = 10_000;

export const AGENT_RUNTIME_LABELS = {
  grok: "Grok 4.6",
  scripted: "Scripted",
  noKey: "Scripted (no key)",
} as const;

export type AgentRuntimeLabel = (typeof AGENT_RUNTIME_LABELS)[keyof typeof AGENT_RUNTIME_LABELS];

/** Sentence stored on a trace step so the UI can name the planner that ran. */
export function agentRuntimeLine(label: AgentRuntimeLabel): string {
  return `Agent runtime: ${label}.`;
}
