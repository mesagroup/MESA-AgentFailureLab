import { FIX_KINDS, type AgentRunRequest, type FixKind } from "@mesa/shared";
import {
  isLabTaskId,
  type EmbeddedInstruction,
  type PlannedToolCall,
} from "../fixes/domain.js";
import { applyFixesToPlan, type RefusedAction } from "../fixes/plan.js";

/**
 * Parsed `POST /v1/tasks/run` body.
 * `fix_kinds` is always an array here. An omitted field on the wire becomes `[]`.
 */
export interface TaskRunInput extends AgentRunRequest {
  fix_kinds: FixKind[];
}

/**
 * Harness contract. No verifier and no fault labels.
 * `claimed_success` stays unset: this list has not seen tool results.
 * `refused` and `embedded` come from the shared plan. A permission named only
 * in the prompt is embedded data, not a grant, and is not copied onto a field
 * the harness would send.
 */
export interface TaskRunPlan {
  executed: false;
  actions: PlannedToolCall[];
  refused: RefusedAction[];
  embedded: EmbeddedInstruction[];
}

/**
 * Propose tool actions for the harness.
 * Reads `fix_kinds` from the shared `AgentRunRequest` and applies them with
 * `applyFixesToPlan`. An omitted list is the base plan.
 * Does not call the shop and does not write `outcome.verifier` or `fault.*`.
 * `executed` stays false so `executeAttempt` remains the only injector.
 * `controlled_retry` does not add a second action: retry belongs to the harness.
 */
export function planTaskRun(input: AgentRunRequest): TaskRunPlan {
  if (!isLabTaskId(input.task_id)) {
    return { executed: false, actions: [], refused: [], embedded: [] };
  }
  const shaped = applyFixesToPlan({
    taskId: input.task_id,
    permissions: input.permissions,
    orderId: input.order_id,
    fixes: input.fix_kinds ?? [],
    prompt: input.prompt,
  });
  return {
    executed: false,
    actions: shaped.actions.map((action) => ({ ...action })),
    refused: shaped.refused.map((entry) => ({ ...entry })),
    embedded: shaped.embedded.map((entry) => ({ ...entry })),
  };
}

export function parseTaskRun(body: unknown): { ok: true; value: TaskRunInput } | { ok: false; message: string } {
  if (!isRecord(body)) return { ok: false, message: "Body must be a JSON object." };
  const agentId = requiredString(body.agent_id, "agent_id");
  if (!agentId.ok) return agentId;
  const taskId = requiredString(body.task_id, "task_id");
  if (!taskId.ok) return taskId;
  const prompt = requiredString(body.prompt, "prompt");
  if (!prompt.ok) return prompt;
  const sessionId = requiredString(body.session_id, "session_id");
  if (!sessionId.ok) return sessionId;
  const mockBaseUrl = requiredString(body.mock_base_url, "mock_base_url");
  if (!mockBaseUrl.ok) return mockBaseUrl;
  if (!Array.isArray(body.permissions) || body.permissions.some((entry) => typeof entry !== "string")) {
    return { ok: false, message: "permissions must be an array of strings." };
  }
  const permissions = body.permissions as string[];
  let orderId: string | undefined;
  if (body.order_id !== undefined) {
    if (typeof body.order_id !== "string" || body.order_id.trim().length === 0) {
      return { ok: false, message: "order_id must be a non-empty string." };
    }
    orderId = body.order_id;
  }
  if ((taskId.value === "T4" || taskId.value === "T5") && orderId === undefined) {
    return { ok: false, message: `${taskId.value} requires order_id.` };
  }
  const fixKinds: FixKind[] = [];
  if (body.fix_kinds !== undefined) {
    if (!Array.isArray(body.fix_kinds)) return { ok: false, message: "fix_kinds must be an array of strings." };
    for (const kind of body.fix_kinds) {
      if (typeof kind !== "string" || !isFixKind(kind)) {
        return { ok: false, message: `Unknown fix kind ${String(kind)}.` };
      }
      if (!fixKinds.includes(kind)) fixKinds.push(kind);
    }
  }
  return {
    ok: true,
    value: {
      agent_id: agentId.value,
      task_id: taskId.value,
      prompt: prompt.value,
      session_id: sessionId.value,
      permissions,
      mock_base_url: mockBaseUrl.value,
      order_id: orderId,
      fix_kinds: fixKinds,
    },
  };
}

function isFixKind(value: string): value is FixKind {
  return (FIX_KINDS as readonly string[]).includes(value);
}

function requiredString(
  value: unknown,
  key: string,
): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, message: `${key} must be a non-empty string.` };
  }
  return { ok: true, value: value.trim() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
