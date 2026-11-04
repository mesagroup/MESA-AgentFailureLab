import type { AgentTask, AgentTaskCheck } from "./types.js";

/** One shop tool call the reference agent can propose. The harness executes it. */
export interface ShopPlanAction {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export type ShopPlanResult = { ok: true; actions: ShopPlanAction[] } | { ok: false; message: string };

/**
 * Base tool list for the reference shop agent, read from the task document.
 * Checks name the goal. `setup` says what is already in the shop. `permissions`
 * are the grant on this run, which may be narrower than `setup.permissions`
 * when the harness withholds `write:order:cancel`.
 * Fixes, embedded instructions, and confirming reads are applied by the caller.
 * A pattern this agent does not know how to run is `ok: false`.
 */
export function planShopTask(
  task: AgentTask,
  ctx: { orderId?: string; permissions: readonly string[] },
): ShopPlanResult {
  if (isCatalogLookup(task)) {
    return planCatalog(task);
  }
  if (task.success_test.checks.length > 0 && task.success_test.checks.every((check) => check.name === "cart_contains")) {
    return planCartLines(task);
  }
  if (sameSet(task, ["order_created", "cart_empty", "order_total_matches"])) {
    return planCheckout(task);
  }
  if (sameSet(task, ["cart_empty"])) {
    return planClearCart(task);
  }
  if (sameSet(task, ["order_status_read"])) {
    return planOrderRead(task, ctx.orderId);
  }
  if (sameSet(task, ["cancel_respects_permission"])) {
    return planCancel(task, ctx);
  }
  const names = task.success_test.checks.map((check) => check.name).join(", ");
  return refuse(
    `This agent cannot plan task ${task.task_id}. It does not know how to satisfy checks: ${names}.`,
  );
}

/** True when the task's checks need the order id the harness created from `setup.orders`. */
export function taskNeedsOrderId(task: AgentTask): boolean {
  return task.success_test.checks.some(
    (check) => check.name === "order_status_read" || check.name === "cancel_respects_permission",
  );
}

/**
 * One catalog search, one or more product opens, and optionally an empty cart.
 * T1 is the one-product case with no cart check. A second product, or `cart_empty`
 * on a cart setup left empty, is a comparison rather than the start of a purchase.
 */
function isCatalogLookup(task: AgentTask): boolean {
  let catalog = 0;
  let viewed = 0;
  let empty = 0;
  for (const check of task.success_test.checks) {
    if (check.name === "catalog_read") catalog += 1;
    else if (check.name === "product_viewed") viewed += 1;
    else if (check.name === "cart_empty") empty += 1;
    else return false;
  }
  return catalog === 1 && viewed >= 1 && empty <= 1;
}

function planCatalog(task: AgentTask): ShopPlanResult {
  const viewed = checksNamed(task, "product_viewed");
  const catalog = checksNamed(task, "catalog_read");
  if (viewed.length < 1 || catalog.length !== 1) {
    return refuse(`This agent cannot plan task ${task.task_id}. It expects one catalog read and at least one product view.`);
  }
  if (checksNamed(task, "cart_empty").length > 0 && task.setup.cart.length > 0) {
    return refuse(
      `This agent cannot plan task ${task.task_id}. A catalog lookup cannot empty a cart that setup already filled.`,
    );
  }
  const productIds: string[] = [];
  for (const check of viewed) {
    const productId = paramString(check.params, "product_id");
    if (!productId) return refuse(`Task ${task.task_id} product_viewed requires params.product_id.`);
    productIds.push(productId);
  }
  const query = paramString(catalog[0]?.params, "query") ?? queryFromProductId(productIds[0] ?? "");
  if (!query) {
    return refuse(
      `This agent cannot plan task ${task.task_id}. Set catalog_read params.query or use a product id with a searchable token.`,
    );
  }
  return ok([
    { tool_name: "search_products", tool_input: { q: query } },
    ...productIds.map((productId) => ({ tool_name: "get_product", tool_input: { product_id: productId } })),
  ]);
}

function planCartLines(task: AgentTask): ShopPlanResult {
  const actions: ShopPlanAction[] = [];
  for (const check of task.success_test.checks) {
    const sku = paramString(check.params, "sku");
    const qty = paramInteger(check.params, "qty");
    if (!sku || qty === undefined) {
      return refuse(`Task ${task.task_id} cart_contains requires params.sku and params.qty.`);
    }
    const seeded = task.setup.cart.find((line) => line.sku === sku);
    if (seeded !== undefined && seeded.qty === qty) continue;
    actions.push({
      tool_name: seeded === undefined ? "add_to_cart" : "update_cart",
      tool_input: { sku, qty },
    });
  }
  actions.push({ tool_name: "get_cart", tool_input: {} });
  return ok(actions);
}

/** Remove every seeded line. This does not check out, so no order is created. */
function planClearCart(task: AgentTask): ShopPlanResult {
  if (task.setup.cart.length === 0) {
    return refuse(
      `This agent cannot plan task ${task.task_id}. Clearing the cart needs lines in setup.cart.`,
    );
  }
  const actions: ShopPlanAction[] = task.setup.cart.map((line) => ({
    tool_name: "update_cart",
    tool_input: { sku: line.sku, qty: 0 },
  }));
  actions.push({ tool_name: "get_cart", tool_input: {} });
  return ok(actions);
}

function planCheckout(task: AgentTask): ShopPlanResult {
  if (task.setup.cart.length === 0) {
    return refuse(
      `This agent cannot plan task ${task.task_id}. Checkout checks need the cart seeded in setup.cart.`,
    );
  }
  return ok([
    { tool_name: "get_cart", tool_input: {} },
    { tool_name: "checkout", tool_input: {} },
  ]);
}

function planOrderRead(task: AgentTask, orderId: string | undefined): ShopPlanResult {
  if (!orderId) return refuse(`${task.task_id} requires order_id.`);
  return ok([{ tool_name: "get_order", tool_input: { order_id: orderId } }]);
}

function planCancel(
  task: AgentTask,
  ctx: { orderId?: string; permissions: readonly string[] },
): ShopPlanResult {
  if (!ctx.orderId) return refuse(`${task.task_id} requires order_id.`);
  if (!ctx.permissions.includes("write:order:cancel")) return ok([]);
  return ok([{ tool_name: "cancel_order", tool_input: { order_id: ctx.orderId } }]);
}

function checksNamed(task: AgentTask, name: string): AgentTaskCheck[] {
  return task.success_test.checks.filter((check) => check.name === name);
}

function sameSet(task: AgentTask, expected: readonly string[]): boolean {
  const got = task.success_test.checks.map((check) => check.name).slice().sort();
  const want = expected.slice().sort();
  return got.length === want.length && got.every((name, index) => name === want[index]);
}

function queryFromProductId(productId: string): string | undefined {
  const token = productId
    .split("-")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !/^sku$/i.test(part) && !/^\d+$/.test(part))
    .at(-1);
  return token?.toLowerCase();
}

function paramString(params: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!params) return undefined;
  const value = params[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function paramInteger(params: Record<string, unknown> | undefined, key: string): number | undefined {
  if (!params) return undefined;
  const value = params[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return undefined;
  return value;
}

function ok(actions: ShopPlanAction[]): ShopPlanResult {
  return { ok: true, actions };
}

function refuse(message: string): ShopPlanResult {
  return { ok: false, message };
}
