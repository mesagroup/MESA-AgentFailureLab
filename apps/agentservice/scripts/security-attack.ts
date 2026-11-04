import type { Agent } from "@mesa/shared";
import type { AgentRunRequest } from "../../backend/src/agent/http.js";
import { runTasks, type TaskRunResult } from "../../backend/src/harness/runner.js";
import type { MockShopClient } from "../../backend/src/mock/client.js";
import type { RunStore } from "../../backend/src/persistence/memory.js";
import { planTaskRun } from "../src/reference-agent/plan.js";
import { securityInjectionPlan, securityPayload } from "../src/security/catalog.js";
import { createSecurityToolHook } from "../src/security/hook.js";

/**
 * Run the T5 security attacker through the backend harness.
 * The agent plan is the existing `planTaskRun` with an empty fix list.
 * Receiving and applying `fix_kinds` on the agent is #61 / #40 and is not done here.
 * `AgentRunRequest` is not given a `fix_kinds` field.
 */

export async function runSecurityAttack(input: {
  agent: Agent;
  store: RunStore;
  mock: MockShopClient;
  mockBaseUrl: string;
  /**
   * When false, the agent returns no actions.
   * That is the action list `permission_guard` already produces. This function does not apply the guard.
   */
  emitCancel?: boolean;
  timeoutMs?: number;
}): Promise<TaskRunResult> {
  const payload = securityPayload();
  const emitCancel = input.emitCancel !== false;
  const [result] = await runTasks({
    agent: input.agent,
    store: input.store,
    mock: input.mock,
    mockBaseUrl: input.mockBaseUrl,
    phase: "injected",
    taskIds: [payload.task_id],
    driver: "http",
    injection: securityInjectionPlan(payload),
    grantCancel: false,
    timeoutMs: input.timeoutMs ?? 5_000,
    attachedNote: payload.note,
    attackerPayloadId: payload.payload_id,
    toolHook: createSecurityToolHook(payload),
    callAgent: (_baseUrl, request) => agentActions(request, emitCancel),
  });
  if (result === undefined || result.trace === null) {
    const message = result?.run.error_message ?? "no trace";
    throw new Error(`Security attacker produced no trace (${message}).`);
  }
  return result;
}

function agentActions(
  request: AgentRunRequest,
  emitCancel: boolean,
): Promise<{ executed: false; actions: Array<{ tool_name: string; tool_input: Record<string, unknown> }> }> {
  if ("fix_kinds" in request) {
    throw new Error("Security attacker does not send fix_kinds on AgentRunRequest.");
  }
  if (!emitCancel) return Promise.resolve({ executed: false, actions: [] });
  const plan = planTaskRun({
    agent_id: request.agent_id,
    task_id: request.task_id,
    prompt: request.prompt,
    session_id: request.session_id,
    permissions: request.permissions,
    mock_base_url: request.mock_base_url,
    order_id: request.order_id,
    fix_kinds: [],
  });
  return Promise.resolve({
    executed: false,
    actions: plan.actions.map((action) => ({
      tool_name: action.tool_name,
      tool_input: { ...action.tool_input },
    })),
  });
}
