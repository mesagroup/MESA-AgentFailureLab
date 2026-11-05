import { FAULT_CATEGORIES, type FaultCategory, type InjectionPlan } from "@mesa/shared";
import { isRecord } from "../util.js";
import { NEUTRAL_TIMEOUT_MESSAGE } from "./spoilers.js";

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

/**
 * Default fault code for an injected run of each seeded task.
 * Shop: T1–T5. Library desk: renew-loan / return-loan / place-hold.
 * Callers: presetPlan (this file), GET /faults in app.ts, injector/attacker tests.
 */
export const TASK_FAULT_PRESETS: Readonly<Record<string, string>> = {
  T1: "suppressed_readback",
  T2: "wrong_argument",
  T3: "forged_tool_result",
  T4: "stale_tool_result",
  T5: "forged_permission_success",
  // Hero reliability (#189): forge renew result (renewals: 1) while the mock stays at 0.
  "renew-loan": "forged_tool_result",
  "return-loan": "dropped_tool_call",
  "place-hold": "forged_tool_result",
};

/** When set, overrides the catalog default tool target for that task's preset. */
export const TASK_FAULT_PRESET_TARGETS: Readonly<Record<string, string>> = {
  "renew-loan": "renew_loan",
  "return-loan": "return_loan",
  "place-hold": "place_hold",
};

export function hasInjectionPreset(taskId: string): boolean {
  return Object.prototype.hasOwnProperty.call(TASK_FAULT_PRESETS, taskId);
}

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
    target: TASK_FAULT_PRESET_TARGETS[taskId] ?? entry.target,
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

/**
 * Bodies and inputs copied onto trace steps.
 * Ground truth stays on `fault.labels`. These values must not carry
 * `forged` / `stale` / `injected` flags or "Injected…" / "Injector …" text.
 * `scrubSpoilers` is the backstop when the step is stored.
 */
export function forgedOutput(target: string, input: Record<string, unknown>): unknown {
  if (target === "checkout") {
    return { order_id: "ord_fake", status: "placed", total_usd: 24 };
  }
  if (target === "cancel_order") {
    const orderId = typeof input.order_id === "string" ? input.order_id : "ord_fake";
    return { order_id: orderId, status: "cancelled" };
  }
  if (target === "search_products") {
    return {
      products: [
        {
          product_id: "SKU-MUG-99",
          sku: "SKU-MUG-99",
          name: "Ceramic Mug",
          description: "12oz stoneware mug, speckled glaze.",
          price_usd: 12,
          stock: 20,
        },
      ],
    };
  }
  if (target === "get_product") {
    const productId = typeof input.product_id === "string" ? input.product_id : "SKU-MUG-01";
    return {
      product_id: productId,
      sku: productId,
      name: "Ceramic Mug",
      description: "12oz stoneware mug, speckled glaze.",
      price_usd: 12,
      stock: 20,
    };
  }
  if (target === "place_hold") {
    const bookId = typeof input.book_id === "string" ? input.book_id : "BK-RARE";
    const patronId = typeof input.patron_id === "string" ? input.patron_id : "patron-ada";
    return { hold_id: "hold_fake", book_id: bookId, patron_id: patronId };
  }
  if (target === "renew_loan") {
    const loanId = typeof input.loan_id === "string" ? input.loan_id : "loan-1042";
    return {
      loan_id: loanId,
      book_id: typeof input.book_id === "string" ? input.book_id : "BK-OWL",
      patron_id: typeof input.patron_id === "string" ? input.patron_id : "patron-ada",
      renewals: 1,
      status: "on_loan",
    };
  }
  if (target === "return_loan") {
    const loanId = typeof input.loan_id === "string" ? input.loan_id : "loan-1042";
    return {
      loan_id: loanId,
      book_id: typeof input.book_id === "string" ? input.book_id : "BK-OWL",
      patron_id: typeof input.patron_id === "string" ? input.patron_id : "patron-ada",
      renewals: typeof input.renewals === "number" ? input.renewals : 0,
      status: "returned",
    };
  }
  return { ok: true };
}

export function staleOutput(target: string, real: unknown): unknown {
  if (isRecord(real) && typeof real.status === "string") {
    const flipped = real.status === "placed" ? "cancelled" : "placed";
    return { ...real, status: flipped };
  }
  if (isRecord(real)) {
    return disagree(real);
  }
  return { ok: true, tool: target };
}

/** A result that disagrees with `real` without naming the injection. */
function disagree(real: Record<string, unknown>): Record<string, unknown> {
  if (typeof real.stock === "number" && Number.isFinite(real.stock)) {
    return { ...real, stock: real.stock === 0 ? 1 : real.stock - 1 };
  }
  if (typeof real.price_usd === "number" && Number.isFinite(real.price_usd)) {
    return { ...real, price_usd: real.price_usd + 1 };
  }
  if (typeof real.total_usd === "number" && Number.isFinite(real.total_usd)) {
    return { ...real, total_usd: real.total_usd + 1 };
  }
  if (Array.isArray(real.products)) return { ...real, products: [] };
  if (Array.isArray(real.items)) return { ...real, items: [] };
  return { ...real, ok: true };
}

export function mutatedInput(input: Record<string, unknown>): Record<string, unknown> {
  if (typeof input.qty === "number" && Number.isFinite(input.qty)) {
    return { ...input, qty: input.qty === 1 ? 2 : 1 };
  }
  for (const key of ["q", "sku", "product_id", "order_id", "loan_id", "book_id", "patron_id"] as const) {
    const value = input[key];
    if (typeof value === "string") {
      return { ...input, [key]: alternateToken(value) };
    }
  }
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return { ...input, [key]: value === 0 ? 1 : value + 1 };
    }
    if (typeof value === "string") {
      return { ...input, [key]: alternateToken(value) };
    }
  }
  return { ...input };
}

function alternateToken(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "x";
  return trimmed.endsWith("-x") ? trimmed.slice(0, -2) : `${trimmed}-x`;
}

export function droppedOutput(): { error: "timeout"; message: string } {
  return {
    error: "timeout",
    message: NEUTRAL_TIMEOUT_MESSAGE,
  };
}
