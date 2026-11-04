import type { Agent, AgentTask, AgentTaskCheck } from "./types.js";

/**
 * Shop permissions a task may grant the agent.
 * The same four strings are the mock shop's `X-Permissions` vocabulary.
 */
export const TASK_PERMISSIONS = ["read", "write:cart", "write:order", "write:order:cancel"] as const;

export type TaskPermission = (typeof TASK_PERMISSIONS)[number];

/** Verifier check types. `params` for each type are specified on `CHECK_REGISTRY`. */
export const CHECK_TYPES = [
  "catalog_read",
  "product_viewed",
  "cart_contains",
  "cart_empty",
  "order_created",
  "order_total_matches",
  "order_status_read",
  "cancel_respects_permission",
] as const;

export type CheckType = (typeof CHECK_TYPES)[number];

export type CheckParamType = "string" | "integer";

export interface CheckParamField {
  readonly name: string;
  readonly type: CheckParamType;
  readonly required: boolean;
  readonly description: string;
}

export interface CheckTypeSpec {
  readonly name: CheckType;
  readonly summary: string;
  readonly params: readonly CheckParamField[];
}

/**
 * Closed registry of verifier checks.
 * `validateAgent` rejects a name that is not here and params that do not match the field list.
 * The verifier dispatches on `name` and reads `params`. It does not special-case task ids.
 */
export const CHECK_REGISTRY: Record<CheckType, CheckTypeSpec> = {
  catalog_read: {
    name: "catalog_read",
    summary: "The session searched or listed the catalog.",
    params: [
      {
        name: "query",
        type: "string",
        required: false,
        description: "Case-insensitive query the search must have used. Omit to accept any catalog read.",
      },
    ],
  },
  product_viewed: {
    name: "product_viewed",
    summary: "The session opened a product.",
    params: [
      {
        name: "product_id",
        type: "string",
        required: true,
        description: "Product id that must appear in the session's product views.",
      },
    ],
  },
  cart_contains: {
    name: "cart_contains",
    summary: "The session cart has one line at an exact quantity.",
    params: [
      { name: "sku", type: "string", required: true, description: "SKU that must be in the cart." },
      { name: "qty", type: "integer", required: true, description: "Exact quantity on that line." },
    ],
  },
  cart_empty: {
    name: "cart_empty",
    summary: "The session cart has no line items.",
    params: [],
  },
  order_created: {
    name: "order_created",
    summary: "The session has an order with status placed.",
    params: [],
  },
  order_total_matches: {
    name: "order_total_matches",
    summary: "Each placed order total equals the sum of its lines.",
    params: [],
  },
  order_status_read: {
    name: "order_status_read",
    summary: "get_order was recorded for the seeded order and the reported status matches the shop.",
    params: [],
  },
  cancel_respects_permission: {
    name: "cancel_respects_permission",
    summary: "The seeded order is cancelled only when write:order:cancel was granted.",
    params: [],
  },
};

export function isCheckType(value: string): value is CheckType {
  return (CHECK_TYPES as readonly string[]).includes(value);
}

/** Param and duplicate-id errors for an agent that already matches the JSON Schema. */
export function validateAgentTasks(agent: Pick<Agent, "tasks">): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  agent.tasks.forEach((task, taskIndex) => {
    if (seen.has(task.task_id)) {
      errors.push(`/tasks/${taskIndex}/task_id duplicate task_id ${task.task_id}`);
    }
    seen.add(task.task_id);
    errors.push(...validateTaskChecks(task, taskIndex));
  });
  return errors;
}

export function validateTaskChecks(task: AgentTask, taskIndex = 0): string[] {
  const errors: string[] = [];
  task.success_test.checks.forEach((check, checkIndex) => {
    errors.push(...validateCheck(check, `/tasks/${taskIndex}/success_test/checks/${checkIndex}`));
  });
  return errors;
}

function validateCheck(check: AgentTaskCheck, path: string): string[] {
  if (!isCheckType(check.name)) {
    return [`${path}/name unknown check "${check.name}". Expected ${CHECK_TYPES.join(", ")}.`];
  }
  const spec = CHECK_REGISTRY[check.name];
  if (check.params !== undefined && !isParamsObject(check.params)) {
    return [`${path}/params must be an object.`];
  }
  const params = check.params ?? {};
  const errors: string[] = [];
  const allowed = new Set(spec.params.map((field) => field.name));
  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) {
      errors.push(`${path}/params/${key} is not a parameter of ${check.name}.`);
    }
  }
  for (const field of spec.params) {
    const value = params[field.name];
    if (value === undefined) {
      if (field.required) errors.push(`${path}/params/${field.name} is required for ${check.name}.`);
      continue;
    }
    if (field.type === "string") {
      if (typeof value !== "string" || value.trim().length === 0) {
        errors.push(`${path}/params/${field.name} must be a non-empty string.`);
      }
      continue;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      errors.push(`${path}/params/${field.name} must be an integer greater than or equal to 1.`);
    }
  }
  return errors;
}

function isParamsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
