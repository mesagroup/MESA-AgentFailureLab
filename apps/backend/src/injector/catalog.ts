import { FAULT_CATEGORIES, type FaultCategory, type InjectionPlan } from "@mesa/shared";
import { isRecord } from "../util.js";

export type FaultEffect = "skip" | "mutate_input" | "forge_output" | "replace_output" | "drop";

export interface FaultDefinition {
  code: string;
  category: FaultCategory;
  /** Default tool the preset aims at. A plan may override `target`. */
  target: string;
  fault: string;
  effect: FaultEffect;
}

/**
 * One labeled fault per Diagnosis category.
 * `ground_truth` on the Run is copied from here. The injector is the only writer of `fault.labels`.
 */
export const FAULT_CATALOG: readonly FaultDefinition[] = [
  {
    code: "omitted_required_step",
    category: "Plan",
    target: "search_products",
    fault: "Omit the catalog search the task needs.",
    effect: "skip",
  },
  {
    code: "forged_tool_result",
    category: "ToolUse",
    target: "checkout",
    fault: "Replace the checkout tool result with a successful order that the mock did not create.",
    effect: "forge_output",
  },
  {
    code: "stale_tool_result",
    category: "Context",
    target: "get_order",
    fault: "Return a stale order status that disagrees with the mock.",
    effect: "replace_output",
  },
  {
    code: "wrong_argument",
    category: "Reasoning",
    target: "add_to_cart",
    fault: "Change the add-to-cart quantity so it no longer matches the task.",
    effect: "mutate_input",
  },
  {
    code: "dropped_tool_call",
    category: "Execution",
    target: "checkout",
    fault: "Drop the checkout call and return a timeout instead of executing it.",
    effect: "drop",
  },
  {
    code: "suppressed_readback",
    category: "Verification",
    target: "get_product",
    fault: "Skip the product read that the task needs before a success claim.",
    effect: "skip",
  },
  {
    code: "forged_permission_success",
    category: "Security",
    target: "cancel_order",
    fault: "Report the order as cancelled without the mock applying the cancel.",
    effect: "forge_output",
  },
];

/** Default fault for an injected run of each reference task. */
export const TASK_FAULT_PRESETS: Readonly<Record<string, string>> = {
  T1: "suppressed_readback",
  T2: "wrong_argument",
  T3: "forged_tool_result",
  T4: "stale_tool_result",
  T5: "forged_permission_success",
};

export function faultByCode(code: string): FaultDefinition {
  const found = FAULT_CATALOG.find((entry) => entry.code === code);
  if (!found) {
    throw new Error(`Unknown fault code ${code}.`);
  }
  return found;
}

export function presetPlan(taskId: string): InjectionPlan {
  const code = TASK_FAULT_PRESETS[taskId];
  if (!code) {
    throw new Error(`No injection preset for ${taskId}.`);
  }
  const entry = faultByCode(code);
  return {
    fault: entry.fault,
    target: entry.target,
    ground_truth: { category: entry.category, code: entry.code },
  };
}

export function isFaultCategory(value: unknown): value is FaultCategory {
  return typeof value === "string" && (FAULT_CATEGORIES as readonly string[]).includes(value);
}

/** Accept a caller-supplied plan only when its code and category match the catalog. */
export function normalizePlan(value: unknown): InjectionPlan {
  if (!isRecord(value)) {
    throw new Error("injection plan must be an object.");
  }
  if (typeof value.fault !== "string" || value.fault.trim().length === 0) {
    throw new Error("injection plan fault must be a non-empty string.");
  }
  if (typeof value.target !== "string" || value.target.trim().length === 0) {
    throw new Error("injection plan target must be a non-empty string.");
  }
  if (!isRecord(value.ground_truth)) {
    throw new Error("injection plan ground_truth must be an object.");
  }
  const category = value.ground_truth.category;
  const code = value.ground_truth.code;
  if (!isFaultCategory(category)) {
    throw new Error("injection plan ground_truth.category is not a fault category.");
  }
  if (typeof code !== "string" || code.trim().length === 0) {
    throw new Error("injection plan ground_truth.code must be a non-empty string.");
  }
  const entry = FAULT_CATALOG.find((item) => item.code === code);
  if (!entry) {
    throw new Error(`Unknown fault code ${code}.`);
  }
  if (entry.category !== category) {
    throw new Error(`Fault code ${code} belongs to ${entry.category}, not ${category}.`);
  }

  const plan: InjectionPlan = {
    fault: value.fault.trim(),
    target: value.target.trim(),
    ground_truth: { category, code },
  };
  if (value.ground_truth.step_id !== undefined) {
    if (typeof value.ground_truth.step_id !== "string" || value.ground_truth.step_id.trim().length === 0) {
      throw new Error("injection plan ground_truth.step_id must be a non-empty string.");
    }
    plan.ground_truth.step_id = value.ground_truth.step_id.trim();
  }
  if (value.at_step !== undefined) {
    if (typeof value.at_step !== "number" || !Number.isInteger(value.at_step) || value.at_step < 0) {
      throw new Error("injection plan at_step must be an integer >= 0.");
    }
    plan.at_step = value.at_step;
  }
  return plan;
}

export function forgedOutput(target: string, input: Record<string, unknown>): unknown {
  if (target === "checkout") {
    return { order_id: "ord_fake", status: "placed", total_usd: 24 };
  }
  if (target === "cancel_order") {
    const orderId = typeof input.order_id === "string" ? input.order_id : "ord_fake";
    return { order_id: orderId, status: "cancelled" };
  }
  return { forged: true, ok: true, tool: target };
}

export function staleOutput(target: string, real: unknown): unknown {
  if (isRecord(real) && typeof real.status === "string") {
    const flipped = real.status === "placed" ? "cancelled" : "placed";
    return { ...real, status: flipped };
  }
  return { stale: true, tool: target };
}

export function mutatedInput(input: Record<string, unknown>): Record<string, unknown> {
  if (typeof input.qty === "number" && Number.isFinite(input.qty)) {
    return { ...input, qty: input.qty === 1 ? 2 : 1 };
  }
  return { ...input, injected: true };
}

export function droppedOutput(): { error: "timeout"; message: string } {
  return {
    error: "timeout",
    message: "Injected execution drop before the mock was called.",
  };
}
