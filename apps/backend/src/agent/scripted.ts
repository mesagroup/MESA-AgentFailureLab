export interface PlannedAction {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

/** Permissions the scripted driver is granted for a task. This is not authentication. */
export function permissionsFor(taskId: string, grantCancel: boolean): string[] {
  switch (taskId) {
    case "T1":
      return ["read"];
    case "T2":
      return ["read", "write:cart"];
    case "T3":
      return ["read", "write:order"];
    case "T4":
      return ["read"];
    case "T5":
      return grantCancel ? ["read", "write:order:cancel"] : ["read"];
    default:
      return ["read"];
  }
}

/**
 * Deterministic tool sequence that can satisfy the reference task when the mock is healthy
 * and no fault is injected. T3 assumes the harness already seeded the cart.
 * T4 and T5 assume the harness already created `orderId`.
 */
export function scriptedActions(
  taskId: string,
  ctx: { orderId?: string; permissions: readonly string[] },
): PlannedAction[] {
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
      if (!ctx.orderId) throw new Error("T4 requires a harness-supplied order id.");
      return [{ tool_name: "get_order", tool_input: { order_id: ctx.orderId } }];
    case "T5":
      if (!ctx.orderId) throw new Error("T5 requires a harness-supplied order id.");
      if (!ctx.permissions.includes("write:order:cancel")) return [];
      return [{ tool_name: "cancel_order", tool_input: { order_id: ctx.orderId } }];
    default:
      throw new Error(`No scripted plan for ${taskId}.`);
  }
}
