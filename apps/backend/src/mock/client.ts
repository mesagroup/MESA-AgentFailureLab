import { isRecord } from "../util.js";
import { parseSnapshot, type ShopSnapshot } from "./snapshot.js";

export interface ShopRequest {
  method: "GET" | "POST" | "PATCH";
  path: string;
  sessionId: string;
  permissions: readonly string[];
  body?: unknown;
}

export interface ShopResponse {
  status: number;
  body: unknown;
}

/** `raw` is the JSON object from the shop. `parsed` is the view the checks read. */
export interface ShopState {
  raw: Record<string, unknown>;
  parsed: ShopSnapshot;
}

export function shopStateFrom(value: unknown): ShopState {
  if (!isRecord(value)) {
    throw new Error("Mock /internal/state did not return an object.");
  }
  return { raw: value, parsed: parseSnapshot(value) };
}

export interface MockShopClient {
  reset(): Promise<ShopState>;
  state(): Promise<ShopState>;
  request(options: ShopRequest): Promise<ShopResponse>;
}

export interface ToolHttpCall {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
}

function stringInput(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function describeToolCall(toolName: string, input: Record<string, unknown>): ToolHttpCall {
  switch (toolName) {
    case "search_products": {
      const query = typeof input.q === "string" ? input.q : "";
      return { method: "GET", path: `/products?q=${encodeURIComponent(query)}` };
    }
    case "get_product": {
      const productId = stringInput(input, "product_id") ?? stringInput(input, "sku");
      if (!productId) throw new Error("get_product requires product_id.");
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
      if (!sku) throw new Error("update_cart requires sku.");
      return { method: "PATCH", path: `/cart/items/${encodeURIComponent(sku)}`, body: { qty: input.qty } };
    }
    case "checkout":
      return { method: "POST", path: "/checkout" };
    case "get_order": {
      const orderId = stringInput(input, "order_id");
      if (!orderId) throw new Error("get_order requires order_id.");
      return { method: "GET", path: `/orders/${encodeURIComponent(orderId)}` };
    }
    case "cancel_order": {
      const orderId = stringInput(input, "order_id");
      if (!orderId) throw new Error("cancel_order requires order_id.");
      return { method: "POST", path: `/orders/${encodeURIComponent(orderId)}/cancel` };
    }
    default:
      throw new Error(`Unknown tool ${toolName}.`);
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Mock shop returned non-JSON (${response.status}).`);
  }
}

export function createHttpMockClient(baseUrl: string, fetchImpl: typeof fetch = fetch): MockShopClient {
  const root = baseUrl.replace(/\/$/, "");

  return {
    async reset() {
      const response = await fetchImpl(`${root}/internal/reset`, { method: "POST" });
      if (!response.ok) throw new Error(`Mock reset failed with ${response.status}.`);
      return shopStateFrom(await readJson(response));
    },
    async state() {
      const response = await fetchImpl(`${root}/internal/state`);
      if (!response.ok) throw new Error(`Mock state failed with ${response.status}.`);
      return shopStateFrom(await readJson(response));
    },
    async request(options) {
      const headers: Record<string, string> = {
        "x-session-id": options.sessionId,
        "x-permissions": options.permissions.join(","),
      };
      let body: string | undefined;
      if (options.body !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(options.body);
      }
      const response = await fetchImpl(`${root}${options.path}`, {
        method: options.method,
        headers,
        body,
      });
      return { status: response.status, body: await readJson(response) };
    },
  };
}
