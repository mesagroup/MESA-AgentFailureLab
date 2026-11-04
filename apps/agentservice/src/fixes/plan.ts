import {
  confirmingRead,
  guardCall,
  isLabTaskId,
  mentionsTool,
  normalizeFixes,
  readEmbeddedInstructions,
  type EmbeddedInstruction,
  type FixKind,
  type LabTaskId,
  type PlannedToolCall,
  type ShopPermission,
  type ShopToolName,
  type UntrustedText,
} from "./domain.js";

/**
 * Action-list view of the same policy `wrapShopClient` enforces at call time.
 * PR #21's `planTaskRun` can return `actions` from `applyFixesToPlan` and keep
 * `executed: false`, so the harness injector stays the only tool boundary.
 * `controlled_retry` does not add a second call here. The harness runs each
 * action once, and a retry needs the tool result.
 */

export interface RefusedAction {
  readonly tool_name: ShopToolName;
  readonly required: ShopPermission;
}

export interface ShapedPlan {
  readonly actions: readonly PlannedToolCall[];
  readonly embedded: readonly EmbeddedInstruction[];
  readonly refused: readonly RefusedAction[];
}

export function basePlan(
  taskId: LabTaskId,
  ctx: { orderId?: string; permissions: readonly string[] },
): PlannedToolCall[] {
  switch (taskId) {
    case "T1":
      return [
        { tool_name: "search_products", tool_input: { q: "mug" } },
        { tool_name: "get_product", tool_input: { product_id: "SKU-MUG-01" } },
      ];
    case "T2":
      return [
        { tool_name: "add_to_cart", tool_input: { sku: "SKU-MUG-01", qty: 2 } },
        { tool_name: "get_cart", tool_input: {} },
      ];
    case "T3":
      return [
        { tool_name: "get_cart", tool_input: {} },
        { tool_name: "checkout", tool_input: {} },
      ];
    case "T4":
      if (ctx.orderId === undefined) throw new Error("T4 requires a harness-supplied order id.");
      return [{ tool_name: "get_order", tool_input: { order_id: ctx.orderId } }];
    case "T5":
      if (ctx.orderId === undefined) throw new Error("T5 requires a harness-supplied order id.");
      if (!ctx.permissions.includes("write:order:cancel")) return [];
      return [{ tool_name: "cancel_order", tool_input: { order_id: ctx.orderId } }];
    default: {
      const exhaustive: never = taskId;
      return exhaustive;
    }
  }
}

export function applyFixesToPlan(input: {
  taskId: LabTaskId;
  permissions: readonly string[];
  orderId?: string;
  fixes: readonly FixKind[];
  prompt?: string;
  notes?: readonly UntrustedText[];
}): ShapedPlan {
  const fixes = normalizeFixes(input.fixes);
  const texts: UntrustedText[] = [];
  if (input.prompt !== undefined && input.prompt.length > 0) {
    texts.push({ source: "user_prompt", text: input.prompt });
  }
  if (input.notes !== undefined) texts.push(...input.notes);
  const embedded = texts.flatMap((entry) => readEmbeddedInstructions(entry));

  let actions = basePlan(input.taskId, { orderId: input.orderId, permissions: input.permissions });
  if (
    mentionsTool(embedded, "cancel_order") &&
    input.orderId !== undefined &&
    !actions.some((action) => action.tool_name === "cancel_order")
  ) {
    actions = [...actions, { tool_name: "cancel_order", tool_input: { order_id: input.orderId } }];
  }

  if (fixes.includes("pre_response_check")) {
    const read = confirmingRead(input.taskId, input.orderId);
    if (read !== null) actions = [...actions, read];
  }

  if (!fixes.includes("permission_guard")) {
    return { actions, embedded, refused: [] };
  }

  const kept: PlannedToolCall[] = [];
  const refused: RefusedAction[] = [];
  for (const action of actions) {
    const decision = guardCall({ tool: action.tool_name, granted: input.permissions, fixes });
    if (decision.allow) kept.push(action);
    else refused.push({ tool_name: action.tool_name, required: decision.required });
  }
  return { actions: kept, embedded, refused };
}

export function assertLabTaskId(value: string): LabTaskId {
  if (!isLabTaskId(value)) throw new Error(`No fix plan for ${value}.`);
  return value;
}
