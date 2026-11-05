import type { AgentTask, CheckType } from "@mesa/shared";
import { CHECK_TYPES, TASK_PERMISSIONS } from "@mesa/shared";

/** Derived from task setup/checks — not from `world.kind` (not used in the FE form). */
export type TaskDomain = "shop" | "library" | "mixed";

type TaskPermission = (typeof TASK_PERMISSIONS)[number];

const LIBRARY_CHECK_NAMES = new Set<CheckType>(["loan_renewed", "loan_returned", "hold_placed"]);

const SHOP_CHECK_NAMES = new Set<CheckType>(
  CHECK_TYPES.filter((name) => !LIBRARY_CHECK_NAMES.has(name)),
);

const SHOP_PERMISSIONS = new Set<TaskPermission>([
  "read",
  "write:cart",
  "write:order",
  "write:order:cancel",
]);

const LIBRARY_PERMISSIONS = new Set<TaskPermission>(["read", "write:loan", "write:hold"]);

export function isLibraryCheck(name: string): boolean {
  return LIBRARY_CHECK_NAMES.has(name as CheckType);
}

export function isShopCheck(name: string): boolean {
  return SHOP_CHECK_NAMES.has(name as CheckType);
}

/**
 * Infer domain from task content.
 * library if any library loans or library checks; shop if cart/orders/shop checks;
 * mixed when both (or neither clear) so the form stays neutral.
 */
export function deriveTaskDomain(tasks: AgentTask[]): TaskDomain {
  let library = false;
  let shop = false;
  for (const task of tasks) {
    if ((task.setup.library?.loans.length ?? 0) > 0) library = true;
    if (task.setup.cart.length > 0 || task.setup.orders.length > 0) shop = true;
    for (const check of task.success_test.checks) {
      if (isLibraryCheck(check.name)) library = true;
      if (isShopCheck(check.name)) shop = true;
    }
  }
  if (library && shop) return "mixed";
  if (library) return "library";
  if (shop) return "shop";
  return "mixed";
}

export function checksForDomain(domain: TaskDomain): readonly CheckType[] {
  if (domain === "library") return CHECK_TYPES.filter((name) => LIBRARY_CHECK_NAMES.has(name));
  if (domain === "shop") return CHECK_TYPES.filter((name) => SHOP_CHECK_NAMES.has(name));
  return CHECK_TYPES;
}

export function permissionsForDomain(domain: TaskDomain): readonly TaskPermission[] {
  if (domain === "library") {
    return TASK_PERMISSIONS.filter((permission) => LIBRARY_PERMISSIONS.has(permission));
  }
  if (domain === "shop") {
    return TASK_PERMISSIONS.filter((permission) => SHOP_PERMISSIONS.has(permission));
  }
  return TASK_PERMISSIONS;
}

/**
 * Intro copy follows the derived domain. Both setup editors stay available so
 * create (shop-default blank) can still add library loans / checks without a domain picker.
 */
export function domainSetupCopy(domain: TaskDomain): {
  intro: string;
  setupShop: boolean;
  setupLibrary: boolean;
} {
  const intro =
    domain === "library"
      ? "Setup runs before the agent. Checks are scored from library state. An evalset helps Grok judge the Trace or Run and does not replace the verifier."
      : domain === "shop"
        ? "Setup runs before the agent. Checks are scored from shop state. An evalset helps Grok judge the Trace or Run and does not replace the verifier."
        : "Setup runs before the agent. Checks are scored from mock world state for this agent's domain. An evalset helps Grok judge the Trace or Run and does not replace the verifier.";
  return { intro, setupShop: true, setupLibrary: true };
}

export function defaultCheckForDomain(domain: TaskDomain): CheckType {
  if (domain === "library") return "loan_renewed";
  return "catalog_read";
}
