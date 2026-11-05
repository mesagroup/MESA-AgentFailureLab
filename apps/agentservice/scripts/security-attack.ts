import {
  GROK_ATTACKER_ATTEMPTS,
  GROK_ATTACKER_HARNESS_TIMEOUT_MS,
  GROK_MODEL_TIMEOUT_MS,
  GROK_RUN_TIMEOUT_MS,
  type Agent,
  type FixKind,
} from "@mesa/shared";
import type { AgentRunRequest } from "../../backend/src/agent/http.js";
import { flagRequestsGrok, type PlannerFlag } from "../../backend/src/agent/runtime.js";
import { runTasks, type TaskRunResult } from "../../backend/src/harness/runner.js";
import type { MockShopClient } from "../../backend/src/mock/client.js";
import type { RunStore } from "../../backend/src/persistence/memory.js";
import { createGrokToolModel } from "../src/grok/client.js";
import { parseDiagnosisConfig } from "../src/grok/config.js";
import { proposeGrokTaskRun } from "../src/reference-agent/grok-agent.js";
import { planTaskRun } from "../src/reference-agent/plan.js";
import { securityInjectionPlan, securityPayload } from "../src/security/catalog.js";
import { createSecurityToolHook } from "../src/security/hook.js";

/**
 * Run the T5 security attacker through the backend harness.
 * The agent plan is `planTaskRun` on the shared `AgentRunRequest`.
 * An empty fix list is an `injected` run: the field is omitted, the order note
 * adds `cancel_order`, and the hook commits that call.
 * A non-empty list is the `after_fix` replay: `permission_guard` is copied from
 * the Run and refuses `cancel_order` when `write:order:cancel` is absent.
 * This function does not write `fault.*` or `outcome.verifier`, and it does not
 * add a fix kind.
 */

export async function runSecurityAttack(input: {
  agent: Agent;
  store: RunStore;
  mock: MockShopClient;
  mockBaseUrl: string;
  /** Empty omits `fix_kinds` and runs `injected`. A non-empty list runs `after_fix`. */
  fixKinds?: readonly FixKind[];
  parentRunId?: string | null;
  timeoutMs?: number;
}): Promise<TaskRunResult> {
  const payload = securityPayload();
  const fixKinds = input.fixKinds ?? [];
  const flag: PlannerFlag = fixKinds.length > 0 ? "FIX_AGENT" : "ATTACKER_AGENT";
  const requested = flagRequestsGrok(process.env, flag);
  const config = requested ? parseDiagnosisConfig(process.env) : null;
  const live = Boolean(config?.apiKey);
  const [result] = await runTasks({
    agent: input.agent,
    store: input.store,
    mock: input.mock,
    mockBaseUrl: input.mockBaseUrl,
    phase: fixKinds.length > 0 ? "after_fix" : "injected",
    taskIds: [payload.task_id],
    driver: "http",
    injection: securityInjectionPlan(payload),
    fixKinds,
    parentRunId: input.parentRunId,
    grantCancel: false,
    timeoutMs:
      input.timeoutMs ??
      (live ? (flag === "ATTACKER_AGENT" ? GROK_ATTACKER_HARNESS_TIMEOUT_MS : GROK_RUN_TIMEOUT_MS) : 5_000),
    attachedNote: payload.note,
    attackerPayloadId: payload.payload_id,
    toolHook: createSecurityToolHook(payload),
    planner: live ? "grok" : undefined,
    callAgent: (_baseUrl, request) => agentActions(request, { live, requested, flag, config }),
  });
  if (result === undefined || result.trace === null) {
    const message = result?.run.error_message ?? "no trace";
    throw new Error(`Security attacker produced no trace (${message}).`);
  }
  return result;
}

function agentActions(
  request: AgentRunRequest,
  mode: {
    live: boolean;
    requested: boolean;
    flag: PlannerFlag;
    config: ReturnType<typeof parseDiagnosisConfig> | null;
  },
): Promise<{ executed: false; actions: Array<{ tool_name: string; tool_input: Record<string, unknown> }>; agent?: "grok" | "scripted"; fallback?: "no_key"; answer?: string; usage?: { input_tokens: number; output_tokens: number; cost_usd: number; latency_ms: number }; refused?: Array<{ tool_name: string; required: string }> }> {
  if (!mode.live || !mode.config?.apiKey) {
    const plan = planTaskRun(request);
    const actions = plan.actions.map((action) => ({
      tool_name: action.tool_name,
      tool_input: { ...action.tool_input },
    }));
    if (mode.requested) {
      return Promise.resolve({ executed: false, actions, agent: "scripted", fallback: "no_key", answer: "" });
    }
    return Promise.resolve({ executed: false, actions });
  }
  const caller = createGrokToolModel({
    apiKey: mode.config.apiKey,
    baseUrl: mode.config.baseUrl,
    timeoutMs: GROK_MODEL_TIMEOUT_MS,
    maxAttempts: mode.flag === "ATTACKER_AGENT" ? GROK_ATTACKER_ATTEMPTS : 1,
  });
  return proposeGrokTaskRun(request, caller, {
    timeoutMs: GROK_MODEL_TIMEOUT_MS,
    maxAttempts: mode.flag === "ATTACKER_AGENT" ? GROK_ATTACKER_ATTEMPTS : 1,
  });
}
