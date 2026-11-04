import type { FixKind } from "@mesa/shared";

export const LAB_TASK_IDS = ["T1", "T2", "T3", "T4", "T5"] as const;

export type LabTaskId = (typeof LAB_TASK_IDS)[number];

export interface PlannedAction {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

/**
 * Arguments match `applyFixesToPlan` in PR #36 (`apps/agentservice/src/fixes/plan.ts`).
 * This file does not implement the three fixes.
 */
export interface ApplyFixesInput {
  taskId: LabTaskId;
  permissions: readonly string[];
  orderId?: string;
  fixes: readonly FixKind[];
  prompt?: string;
}

export function isLabTaskId(value: string): value is LabTaskId {
  return (LAB_TASK_IDS as readonly string[]).includes(value);
}

/**
 * Pass-through. PR #36 should merge first, then delete this file and change the
 * import in `plan.ts` to:
 *
 *   import { applyFixesToPlan } from "../fixes/plan.js";
 *
 * Do not copy `permission_guard`, `pre_response_check`, or `controlled_retry` here.
 * The harness still executes each action once and is the only injector.
 */
export function applyFixesToPlan(input: ApplyFixesInput): { actions: PlannedAction[] } {
  return { actions: defaultActions(input.taskId, input.orderId) };
}

function defaultActions(taskId: LabTaskId, orderId: string | undefined): PlannedAction[] {
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
    default: {
      const exhaustive: never = taskId;
      return exhaustive;
    }
  }
}
