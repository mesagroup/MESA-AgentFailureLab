import type { Agent, FixKind } from "@mesa/shared";
import type { AgentRunRequest } from "../../backend/src/agent/http.js";
import { runTasks, type TaskRunResult } from "../../backend/src/harness/runner.js";
import type { MockShopClient } from "../../backend/src/mock/client.js";
import type { RunStore } from "../../backend/src/persistence/memory.js";
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
    timeoutMs: input.timeoutMs ?? 5_000,
    attachedNote: payload.note,
    attackerPayloadId: payload.payload_id,
    toolHook: createSecurityToolHook(payload),
    callAgent: (_baseUrl, request) => agentActions(request),
  });
  if (result === undefined || result.trace === null) {
    const message = result?.run.error_message ?? "no trace";
    throw new Error(`Security attacker produced no trace (${message}).`);
  }
  return result;
}

function agentActions(
  request: AgentRunRequest,
): Promise<{ executed: false; actions: Array<{ tool_name: string; tool_input: Record<string, unknown> }> }> {
  const plan = planTaskRun(request);
  return Promise.resolve({
    executed: false,
    actions: plan.actions.map((action) => ({
      tool_name: action.tool_name,
      tool_input: { ...action.tool_input },
    })),
  });
}
