import { FIX_KINDS, type FixKind } from "@mesa/shared";
import {
  applyFixesToPlan,
  isLabTaskId,
  type PlannedAction,
} from "./apply-fixes-hook.js";

export interface TaskRunInput {
  agent_id: string;
  task_id: string;
  prompt: string;
  session_id: string;
  permissions: string[];
  mock_base_url: string;
  order_id?: string;
  fix_kinds: FixKind[];
}

/** Harness contract. No verifier and no fault labels. `claimed_success` stays unset. */
export interface TaskRunPlan {
  executed: false;
  actions: PlannedAction[];
}

/**
 * Propose tool actions for the harness.
 * Does not call the shop and does not write `outcome.verifier` or `fault.*`.
 * Fix policy is the single `applyFixesToPlan` call below.
 */
export function planTaskRun(input: TaskRunInput): TaskRunPlan {
  if (!isLabTaskId(input.task_id)) {
    return { executed: false, actions: [] };
  }
  const shaped = applyFixesToPlan({
    taskId: input.task_id,
    permissions: input.permissions,
    orderId: input.order_id,
    fixes: input.fix_kinds,
    prompt: input.prompt,
  });
  return {
    executed: false,
    actions: shaped.actions.map((action) => ({ ...action })),
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
