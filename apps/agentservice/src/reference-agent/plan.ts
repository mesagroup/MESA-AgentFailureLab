import { FIX_KINDS, type FixKind } from "@mesa/shared";

export interface PlannedAction {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

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

export interface TaskRunPlan {
  executed: false;
  claimed_success: boolean;
  actions: PlannedAction[];
}

const READ_TOOLS = new Set(["search_products", "get_product", "get_cart", "get_order"]);

/**
 * Propose tool actions for the harness.
 * This process does not call the shop and does not write `outcome.verifier` or `fault.*`.
 * `executeAttempt` in the backend is the only tool boundary and the only injector.
 * `controlled_retry` is accepted as a fix id and does not duplicate calls here, because
 * a retry would be a second execution of the tool.
 */
export function planTaskRun(input: TaskRunInput): TaskRunPlan {
  let actions = defaultActions(input.task_id, input.order_id);
  if (input.fix_kinds.includes("permission_guard")) {
    const granted = input.permissions.includes("write:order:cancel");
    actions = actions.filter((action) => action.tool_name !== "cancel_order" || granted);
  }
  if (input.fix_kinds.includes("pre_response_check")) {
    actions = withReadBack(input.task_id, actions, input.order_id);
  }
  const blockedCancel =
    input.task_id === "T5" &&
    input.fix_kinds.includes("permission_guard") &&
    !input.permissions.includes("write:order:cancel");
  return {
    executed: false,
    claimed_success: !blockedCancel && actions.length > 0,
    actions,
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

function defaultActions(taskId: string, orderId: string | undefined): PlannedAction[] {
  switch (taskId) {
    case "T1":
      return [
        { tool_name: "search_products", tool_input: { q: "mug" } },
        { tool_name: "get_product", tool_input: { product_id: "SKU-MUG-01" } },
      ];
    case "T2":
      return [{ tool_name: "add_to_cart", tool_input: { sku: "SKU-MUG-01", qty: 2 } }];
    case "T3":
      return [{ tool_name: "checkout", tool_input: {} }];
    case "T4":
      return [{ tool_name: "get_order", tool_input: { order_id: orderId ?? "" } }];
    case "T5":
      return [{ tool_name: "cancel_order", tool_input: { order_id: orderId ?? "" } }];
    default:
      return [];
  }
}

function withReadBack(taskId: string, actions: PlannedAction[], orderId: string | undefined): PlannedAction[] {
  const last = actions.at(-1)?.tool_name;
  if (last !== undefined && READ_TOOLS.has(last)) return actions;
  if ((taskId === "T4" || taskId === "T5") && orderId) {
    return [...actions, { tool_name: "get_order", tool_input: { order_id: orderId } }];
  }
  if (taskId === "T1") {
    return [...actions, { tool_name: "get_product", tool_input: { product_id: "SKU-MUG-01" } }];
  }
  return [...actions, { tool_name: "get_cart", tool_input: {} }];
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
