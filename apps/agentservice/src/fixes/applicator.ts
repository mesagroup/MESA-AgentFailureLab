import {
  backoffMs,
  guardCall,
  isRecord,
  parseApplicatorConfig,
  retryDecision,
  type ApplicatorConfig,
  type FixKind,
  type PlannedToolCall,
  type ShopPermission,
  type ShopToolName,
} from "./domain.js";

/**
 * Shop tool client. The wrapper never talks to the injector.
 * Faults are applied only when this client is the backend harness.
 */
export interface ShopToolResponse {
  readonly status: number;
  readonly body: unknown;
  /**
   * False only when the transport knows the request did not reach the shop.
   * A timeout after the bytes were sent is true: a mutate tool may have committed.
   */
  readonly dispatched: boolean;
}

export interface ShopToolClient {
  call(input: {
    tool_name: ShopToolName;
    tool_input: Record<string, unknown>;
    sessionId: string;
    permissions: readonly string[];
  }): Promise<ShopToolResponse>;
}

export type ResponseClass = "success" | "transient" | "terminal";

export type AppliedCall =
  | {
      readonly outcome: "refused";
      readonly tool_name: ShopToolName;
      readonly reason: "missing_permission";
      readonly required: ShopPermission;
      readonly attempts: 0;
      readonly latency_ms: number;
    }
  | {
      readonly outcome: ResponseClass;
      readonly tool_name: ShopToolName;
      readonly status: number;
      readonly body: unknown;
      readonly attempts: number;
      readonly slept_ms: readonly number[];
      readonly latency_ms: number;
    };

export type TaskGoal =
  | { readonly kind: "product_opened"; readonly product_id: string }
  | { readonly kind: "cart_line"; readonly sku: string; readonly qty: number }
  | { readonly kind: "checked_out"; readonly hinted_order_id?: string }
  | { readonly kind: "order_status"; readonly order_id: string }
  | { readonly kind: "cancel_permission"; readonly order_id: string; readonly cancel_granted: boolean };

export interface GoalConfirmation {
  readonly claim: boolean;
  readonly mismatches: readonly string[];
  readonly reads: readonly AppliedCall[];
  readonly reported_order_status?: string;
}

export interface FixedShopClient {
  call(input: {
    tool_name: ShopToolName;
    tool_input: Record<string, unknown>;
    sessionId: string;
    permissions: readonly string[];
  }): Promise<AppliedCall>;
  confirmGoal(input: {
    goal: TaskGoal;
    sessionId: string;
    permissions: readonly string[];
  }): Promise<GoalConfirmation>;
}

export interface WrapShopClientOptions {
  readonly client: ShopToolClient;
  readonly fixes: readonly FixKind[];
  readonly config?: { maxRetries?: number; baseBackoffMs?: number };
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const TRANSIENT_STATUSES = new Set([0, 408, 429, 500, 502, 503, 504]);

export function classifyResponse(response: ShopToolResponse): ResponseClass {
  if (isRecord(response.body) && response.body.error === "timeout") return "transient";
  if (TRANSIENT_STATUSES.has(response.status) || response.status >= 500) return "transient";
  if (response.status >= 400) return "terminal";
  return "success";
}

export function wrapShopClient(options: WrapShopClientOptions): FixedShopClient {
  const fixes = options.fixes;
  const config: ApplicatorConfig = parseApplicatorConfig(options.config ?? {});
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  async function call(input: {
    tool_name: ShopToolName;
    tool_input: Record<string, unknown>;
    sessionId: string;
    permissions: readonly string[];
  }): Promise<AppliedCall> {
    const started = now();
    const decision = guardCall({ tool: input.tool_name, granted: input.permissions, fixes });
    if (!decision.allow) {
      return {
        outcome: "refused",
        tool_name: input.tool_name,
        reason: decision.reason,
        required: decision.required,
        attempts: 0,
        latency_ms: Math.max(0, now() - started),
      };
    }

    const slept: number[] = [];
    let completed = 0;
    let response: ShopToolResponse = { status: 0, body: { error: "timeout" }, dispatched: false };
    let outcome: ResponseClass = "transient";
    for (;;) {
      response = await options.client.call(input);
      completed += 1;
      outcome = classifyResponse(response);
      if (outcome !== "transient") break;
      const again = retryDecision({
        tool: input.tool_name,
        dispatched: response.dispatched,
        completedAttempts: completed,
        maxRetries: config.maxRetries,
        fixes,
      });
      if (again === "stop") break;
      const wait = backoffMs(config.baseBackoffMs, completed);
      slept.push(wait);
      if (wait > 0) await sleep(wait);
    }

    return {
      outcome,
      tool_name: input.tool_name,
      status: response.status,
      body: response.body,
      attempts: completed,
      slept_ms: slept,
      latency_ms: Math.max(0, now() - started),
    };
  }

  async function confirmGoal(input: {
    goal: TaskGoal;
    sessionId: string;
    permissions: readonly string[];
  }): Promise<GoalConfirmation> {
    const reads: AppliedCall[] = [];
    const mismatches: string[] = [];
    let reported: string | undefined;

    async function read(tool: PlannedToolCall): Promise<AppliedCall> {
      const applied = await call({
        tool_name: tool.tool_name,
        tool_input: tool.tool_input,
        sessionId: input.sessionId,
        permissions: input.permissions,
      });
      reads.push(applied);
      if (tool.tool_name === "get_order" && applied.outcome === "success") {
        const status = orderStatusOf(applied.body);
        if (status !== undefined) reported = status;
      }
      return applied;
    }

    const goal = input.goal;
    switch (goal.kind) {
      case "product_opened": {
        const applied = await read({
          tool_name: "get_product",
          tool_input: { product_id: goal.product_id },
        });
        const seen = applied.outcome === "success" ? productIdOf(applied.body) : undefined;
        if (seen !== goal.product_id) {
          mismatches.push(`Product read returned ${seen ?? "no product"}.`);
        }
        break;
      }
      case "cart_line": {
        const applied = await read({ tool_name: "get_cart", tool_input: {} });
        const lines = applied.outcome === "success" ? cartLines(applied.body) : null;
        const line = lines?.find((entry) => entry.sku === goal.sku);
        if (lines === null) mismatches.push("get_cart did not return items.");
        else if (line === undefined) mismatches.push(`Cart has no line for ${goal.sku}.`);
        else if (line.qty !== goal.qty) mismatches.push(`Cart has ${goal.sku} qty ${line.qty}.`);
        break;
      }
      case "checked_out": {
        const cart = await read({ tool_name: "get_cart", tool_input: {} });
        const lines = cart.outcome === "success" ? cartLines(cart.body) : null;
        if (lines === null) mismatches.push("get_cart did not return items.");
        else if (lines.length > 0) mismatches.push(`Cart still has ${lines.length} line(s).`);
        const hinted = goal.hinted_order_id;
        if (hinted === undefined || hinted.length === 0) {
          mismatches.push("No order id to re-read.");
        } else if (lines !== null && lines.length === 0) {
          const order = await read({ tool_name: "get_order", tool_input: { order_id: hinted } });
          const status = order.outcome === "success" ? orderStatusOf(order.body) : undefined;
          if (status !== "placed") mismatches.push(`Re-read order ${hinted} is ${status ?? "missing"}.`);
        }
        break;
      }
      case "order_status": {
        const order = await read({ tool_name: "get_order", tool_input: { order_id: goal.order_id } });
        const status = order.outcome === "success" ? orderStatusOf(order.body) : undefined;
        if (status === undefined) mismatches.push(`get_order did not return a status for ${goal.order_id}.`);
        break;
      }
      case "cancel_permission": {
        const order = await read({ tool_name: "get_order", tool_input: { order_id: goal.order_id } });
        const status = order.outcome === "success" ? orderStatusOf(order.body) : undefined;
        const expected = goal.cancel_granted ? "cancelled" : "placed";
        if (status !== expected) {
          mismatches.push(`Order ${goal.order_id} is ${status ?? "missing"}; expected ${expected}.`);
        }
        break;
      }
      default: {
        const exhaustive: never = goal;
        return exhaustive;
      }
    }

    const confirmation: GoalConfirmation = {
      claim: mismatches.length === 0,
      mismatches,
      reads,
    };
    if (reported !== undefined) return { ...confirmation, reported_order_status: reported };
    return confirmation;
  }

  return { call, confirmGoal };
}

export function createHttpShopToolClient(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): ShopToolClient {
  const root = baseUrl.replace(/\/$/, "");
  return {
    async call(input) {
      const httpCall = describeToolCall(input.tool_name, input.tool_input);
      const headers: Record<string, string> = {
        "x-session-id": input.sessionId,
        "x-permissions": input.permissions.join(","),
      };
      let body: string | undefined;
      if (httpCall.body !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(httpCall.body);
      }
      try {
        const response = await fetchImpl(`${root}${httpCall.path}`, {
          method: httpCall.method,
          headers,
          body,
        });
        return { status: response.status, body: await readJson(response), dispatched: true };
      } catch (error) {
        const dispatched = !(error instanceof TypeError);
        return {
          status: 0,
          body: { error: "timeout", message: "Shop request failed before a response." },
          dispatched,
        };
      }
    },
  };
}

export function hintedOrderId(tool: ShopToolName, body: unknown): string | undefined {
  if (tool !== "checkout" || !isRecord(body) || typeof body.error === "string") return undefined;
  return typeof body.order_id === "string" && body.order_id.length > 0 ? body.order_id : undefined;
}

export function reportedOrderStatus(tool: ShopToolName, body: unknown): string | undefined {
  if (tool !== "get_order") return undefined;
  return orderStatusOf(body);
}

interface ToolHttpCall {
  readonly method: "GET" | "POST" | "PATCH";
  readonly path: string;
  readonly body?: Record<string, unknown>;
}

function describeToolCall(tool: ShopToolName, input: Record<string, unknown>): ToolHttpCall {
  switch (tool) {
    case "search_products": {
      const query = typeof input.q === "string" ? input.q : "";
      return { method: "GET", path: `/products?q=${encodeURIComponent(query)}` };
    }
    case "get_product": {
      const productId = stringInput(input, "product_id") ?? stringInput(input, "sku");
      if (productId === undefined) throw new Error("get_product requires product_id.");
      return { method: "GET", path: `/products/${encodeURIComponent(productId)}` };
    }
    case "get_cart":
      return { method: "GET", path: "/cart" };
    case "add_to_cart":
      return {
        method: "POST",
        path: "/cart/items",
        body: {
          sku: stringInput(input, "sku") ?? stringInput(input, "product_id") ?? "",
          qty: input.qty,
        },
      };
    case "update_cart": {
      const sku = stringInput(input, "sku");
      if (sku === undefined) throw new Error("update_cart requires sku.");
      return { method: "PATCH", path: `/cart/items/${encodeURIComponent(sku)}`, body: { qty: input.qty } };
    }
    case "checkout":
      return { method: "POST", path: "/checkout" };
    case "get_order": {
      const orderId = stringInput(input, "order_id");
      if (orderId === undefined) throw new Error("get_order requires order_id.");
      return { method: "GET", path: `/orders/${encodeURIComponent(orderId)}` };
    }
    case "cancel_order": {
      const orderId = stringInput(input, "order_id");
      if (orderId === undefined) throw new Error("cancel_order requires order_id.");
      return { method: "POST", path: `/orders/${encodeURIComponent(orderId)}/cancel` };
    }
    default: {
      const exhaustive: never = tool;
      return exhaustive;
    }
  }
}

function stringInput(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    throw new Error(`Shop returned non-JSON (${response.status}).`);
  }
}

function productIdOf(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  if (typeof body.product_id === "string") return body.product_id;
  if (typeof body.sku === "string") return body.sku;
  return undefined;
}

function cartLines(body: unknown): Array<{ sku: string; qty: number }> | null {
  if (!isRecord(body) || !Array.isArray(body.items)) return null;
  const lines: Array<{ sku: string; qty: number }> = [];
  for (const item of body.items) {
    if (!isRecord(item) || typeof item.sku !== "string" || typeof item.qty !== "number") return null;
    lines.push({ sku: item.sku, qty: item.qty });
  }
  return lines;
}

function orderStatusOf(body: unknown): string | undefined {
  if (!isRecord(body) || typeof body.error === "string") return undefined;
  return typeof body.status === "string" ? body.status : undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
