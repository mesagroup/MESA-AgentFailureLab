import { FIX_KINDS, planShopTask, taskNeedsOrderId, type AgentRunRequest, type AgentTask, type FixKind } from "@mesa/shared";
import { validateAgentTask } from "@mesa/shared/validate";
import {
  confirmingRead,
  guardCall,
  isLabTaskId,
  isShopToolName,
  mentionsTool,
  readEmbeddedInstructions,
  type EmbeddedInstruction,
  type LabTaskId,
  type PlannedToolCall,
  type ShopToolName,
} from "../fixes/domain.js";
import { applyFixesToPlan, basePlan, type RefusedAction } from "../fixes/plan.js";

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

/** The task's checks are valid, and this agent still has no plan for them. */
export class UnsupportedTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedTaskError";
  }
}

/**
 * Propose tool actions for the harness.
 * The base list comes from `task`. When that list is the canonical lab plan,
 * fixes are applied with `applyFixesToPlan` unchanged. Any other task this
 * agent can run gets the same fix shaping on the data-driven list.
 * A task it cannot run throws `UnsupportedTaskError`.
 * Does not call the shop and does not write `outcome.verifier` or `fault.*`.
 * `executed` stays false so `executeAttempt` remains the only injector.
 * `controlled_retry` does not add a second action: retry belongs to the harness.
 */
export function planTaskRun(input: AgentRunRequest): TaskRunPlan {
  if (input.task.task_id !== input.task_id) {
    throw new UnsupportedTaskError("task.task_id must match task_id.");
  }
  const planned = planShopTask(input.task, {
    orderId: input.order_id,
    permissions: input.permissions,
  });
  if (!planned.ok) throw new UnsupportedTaskError(planned.message);

  const canonical = canonicalLabPlan(input);
  if (canonical !== undefined && sameActions(planned.actions, canonical.actions)) {
    const shaped = applyFixesToPlan({
      taskId: canonical.taskId,
      permissions: input.permissions,
      orderId: input.order_id,
      fixes: input.fix_kinds ?? [],
      prompt: input.prompt,
    });
    return toPlan(shaped);
  }
  return shapeDataPlan(planned.actions, input);
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
  const taskResult = validateAgentTask(body.task);
  if (!taskResult.ok) {
    const detail = taskResult.errors.join("; ");
    return { ok: false, message: body.task === undefined ? "task is required." : `task is invalid: ${detail}` };
  }
  if (taskResult.value.task_id !== taskId.value) {
    return { ok: false, message: "task.task_id must match task_id." };
  }
  let orderId: string | undefined;
  if (body.order_id !== undefined) {
    if (typeof body.order_id !== "string" || body.order_id.trim().length === 0) {
      return { ok: false, message: "order_id must be a non-empty string." };
    }
    orderId = body.order_id;
  }
  if (taskNeedsOrderId(taskResult.value) && orderId === undefined) {
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
      task: taskResult.value,
      prompt: prompt.value,
      session_id: sessionId.value,
      permissions,
      mock_base_url: mockBaseUrl.value,
      order_id: orderId,
      fix_kinds: fixKinds,
    },
  };
}

function canonicalLabPlan(input: AgentRunRequest): { taskId: LabTaskId; actions: PlannedToolCall[] } | undefined {
  if (!isLabTaskId(input.task_id)) return undefined;
  try {
    return {
      taskId: input.task_id,
      actions: basePlan(input.task_id, { orderId: input.order_id, permissions: input.permissions }),
    };
  } catch {
    return undefined;
  }
}

function sameActions(
  left: readonly { tool_name: string; tool_input: Record<string, unknown> }[],
  right: readonly { tool_name: string; tool_input: Record<string, unknown> }[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((action, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      action.tool_name === other.tool_name &&
      JSON.stringify(action.tool_input) === JSON.stringify(other.tool_input)
    );
  });
}

function toPlan(shaped: {
  actions: readonly PlannedToolCall[];
  refused: readonly RefusedAction[];
  embedded: readonly EmbeddedInstruction[];
}): TaskRunPlan {
  return {
    executed: false,
    actions: shaped.actions.map((action) => ({ ...action, tool_input: { ...action.tool_input } })),
    refused: shaped.refused.map((entry) => ({ ...entry })),
    embedded: shaped.embedded.map((entry) => ({ ...entry })),
  };
}

/**
 * Fix shaping for a task whose base list is not the canonical lab plan.
 * `applyFixesToPlan` stays the path for that canonical list. This applies the
 * same three effects — embedded cancel, confirming read, permission guard —
 * to a list that came from the task document.
 */
function shapeDataPlan(
  actions: readonly { tool_name: string; tool_input: Record<string, unknown> }[],
  input: AgentRunRequest,
): TaskRunPlan {
  const fixes = input.fix_kinds ?? [];
  const embedded = input.prompt.length > 0 ? readEmbeddedInstructions({ source: "user_prompt", text: input.prompt }) : [];
  let next = actions.map((action) => ({
    tool_name: asShopTool(action.tool_name),
    tool_input: { ...action.tool_input },
  }));
  if (
    mentionsTool(embedded, "cancel_order") &&
    input.order_id !== undefined &&
    !next.some((action) => action.tool_name === "cancel_order")
  ) {
    next = [...next, { tool_name: "cancel_order", tool_input: { order_id: input.order_id } }];
  }
  if (fixes.includes("pre_response_check")) {
    const read = confirmingReadFor(input.task, input.order_id);
    if (read !== null) next = [...next, read];
  }
  if (!fixes.includes("permission_guard")) {
    return { executed: false, actions: next, refused: [], embedded };
  }
  const kept: PlannedToolCall[] = [];
  const refused: RefusedAction[] = [];
  for (const action of next) {
    const decision = guardCall({ tool: action.tool_name, granted: input.permissions, fixes });
    if (decision.allow) kept.push(action);
    else refused.push({ tool_name: action.tool_name, required: decision.required });
  }
  return { executed: false, actions: kept, refused, embedded };
}

function confirmingReadFor(task: AgentTask, orderId: string | undefined): PlannedToolCall | null {
  if (isLabTaskId(task.task_id)) return confirmingRead(task.task_id, orderId);
  const names = new Set(task.success_test.checks.map((check) => check.name));
  if (names.has("product_viewed")) {
    const productId = paramString(task, "product_viewed", "product_id");
    if (!productId) return null;
    return { tool_name: "get_product", tool_input: { product_id: productId } };
  }
  if (names.has("cart_contains") || names.has("order_created") || names.has("cart_empty")) {
    return { tool_name: "get_cart", tool_input: {} };
  }
  if ((names.has("order_status_read") || names.has("cancel_respects_permission")) && orderId) {
    return { tool_name: "get_order", tool_input: { order_id: orderId } };
  }
  return null;
}

function paramString(task: AgentTask, checkName: string, key: string): string | undefined {
  const check = task.success_test.checks.find((entry) => entry.name === checkName);
  const value = check?.params?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asShopTool(name: string): ShopToolName {
  if (!isShopToolName(name)) {
    throw new UnsupportedTaskError(`This agent cannot plan a call to ${name}.`);
  }
  return name;
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
