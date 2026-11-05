import { describeFetchError } from "../net/fetch-error.js";
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
  if (Array.isArray(value.loans) && Array.isArray(value.holds) && Array.isArray(value.books)) {
    return {
      raw: value,
      parsed: { carts: [], orders: [], inventory: [], observations: [] },
    };
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
    case "renew_loan":
    case "return_loan": {
      const loanId = stringInput(input, "loan_id");
      if (!loanId) throw new Error(`${toolName} requires loan_id.`);
      const action = toolName === "renew_loan" ? "renew" : "return";
      return { method: "POST", path: `/loans/${encodeURIComponent(loanId)}/${action}` };
    }
    case "get_loan": {
      const loanId = stringInput(input, "loan_id");
      if (!loanId) throw new Error("get_loan requires loan_id.");
      return { method: "GET", path: `/loans/${encodeURIComponent(loanId)}` };
    }
    case "place_hold": {
      const bookId = stringInput(input, "book_id");
      const patronId = stringInput(input, "patron_id");
      if (!bookId || !patronId) throw new Error("place_hold requires book_id and patron_id.");
      return { method: "POST", path: "/holds", body: { book_id: bookId, patron_id: patronId } };
    }
    default:
      throw new Error(`Unknown tool ${toolName}.`);
  }
}

/** Render's free web services answer 502/503/504 while they wake. */
export const MOCK_WAKE_BUDGET_MS = 60_000;

const MOCK_WAKE_STATUSES = new Set([502, 503, 504]);

export function mockWakeDelayMs(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** Math.max(0, attempt - 1));
}

export interface MockWakeOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  budgetMs?: number;
}

/**
 * Retry while the mock process is asleep.
 * 502, 503, 504, and network failures wait with backoff until `budgetMs`.
 * Other statuses return immediately so a real shop error is not hidden.
 */
export async function fetchWhileMockWakes(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit | undefined,
  options: MockWakeOptions = {},
): Promise<Response> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const budget = options.budgetMs ?? MOCK_WAKE_BUDGET_MS;
  const started = now();
  let attempt = 0;
  let lastResponse: Response | undefined;
  let lastError: Error | undefined;
  while (true) {
    attempt += 1;
    try {
      const response = await fetchImpl(url, init);
      if (!MOCK_WAKE_STATUSES.has(response.status)) return response;
      lastResponse = response;
      lastError = new Error(`status ${response.status}`);
    } catch (error) {
      lastResponse = undefined;
      lastError = error instanceof Error ? error : new Error("Mock network error.");
    }
    const remaining = budget - (now() - started);
    if (remaining <= 0) {
      if (lastResponse) return lastResponse;
      throw mockNetworkError(url, lastError ?? new Error("Mock network error."));
    }
    await sleep(Math.min(mockWakeDelayMs(attempt), remaining));
  }
}

function mockNetworkError(url: string, error: Error): Error {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // Keep the raw target when it is not an absolute URL.
  }
  return new Error(`Mock shop ${path} failed: ${describeFetchError(error)}`, { cause: error });
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

export function createHttpMockClient(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  wake: MockWakeOptions = {},
): MockShopClient {
  const root = baseUrl.replace(/\/$/, "");
  const call = (url: string, init?: RequestInit) => fetchWhileMockWakes(fetchImpl, url, init, wake);

  return {
    async reset() {
      const response = await call(`${root}/internal/reset`, { method: "POST" });
      if (!response.ok) throw new Error(`Mock reset failed with ${response.status}.`);
      return shopStateFrom(await readJson(response));
    },
    async state() {
      const response = await call(`${root}/internal/state`);
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
      const response = await call(`${root}${options.path}`, {
        method: options.method,
        headers,
        body,
      });
      return { status: response.status, body: await readJson(response) };
    },
  };
}
