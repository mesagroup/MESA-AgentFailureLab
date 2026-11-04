/**
 * Shape of `GET /internal/state` on the mock shop.
 * The shop package stays the producer. These types only describe what the harness reads.
 */
import { isRecord } from "../util.js";

export interface ShopCartLine {
  product_id: string;
  sku: string;
  name: string;
  qty: number;
  unit_price_usd: number;
}

export interface ShopCart {
  session_id: string;
  items: ShopCartLine[];
  total_usd: number;
}

export interface ShopOrder {
  order_id: string;
  session_id: string;
  status: string;
  items: ShopCartLine[];
  total_usd: number;
  created_at?: string;
  cancelled_at?: string | null;
}

export interface ShopObservation {
  session_id: string;
  catalog_reads: Array<{ query: string; at?: string }>;
  product_views: Array<{ product_id: string; at?: string }>;
  order_reads: Array<{ order_id: string; at?: string }>;
}

export interface ShopSnapshot {
  carts: ShopCart[];
  orders: ShopOrder[];
  inventory: unknown[];
  observations: ShopObservation[];
}

function asLine(value: unknown): ShopCartLine | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.sku !== "string" || typeof value.qty !== "number") return undefined;
  return {
    product_id: typeof value.product_id === "string" ? value.product_id : value.sku,
    sku: value.sku,
    name: typeof value.name === "string" ? value.name : value.sku,
    qty: value.qty,
    unit_price_usd: typeof value.unit_price_usd === "number" ? value.unit_price_usd : 0,
  };
}

function asLines(value: unknown): ShopCartLine[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const line = asLine(entry);
    return line ? [line] : [];
  });
}

export function parseSnapshot(value: unknown): ShopSnapshot {
  if (!isRecord(value)) {
    throw new Error("Mock /internal/state did not return an object.");
  }
  if (!Array.isArray(value.carts) || !Array.isArray(value.orders) || !Array.isArray(value.observations)) {
    throw new Error("Mock /internal/state is missing carts, orders, or observations.");
  }

  const carts: ShopCart[] = [];
  for (const entry of value.carts) {
    if (!isRecord(entry) || typeof entry.session_id !== "string") continue;
    carts.push({
      session_id: entry.session_id,
      items: asLines(entry.items),
      total_usd: typeof entry.total_usd === "number" ? entry.total_usd : 0,
    });
  }

  const orders: ShopOrder[] = [];
  for (const entry of value.orders) {
    if (!isRecord(entry) || typeof entry.order_id !== "string" || typeof entry.session_id !== "string") {
      continue;
    }
    orders.push({
      order_id: entry.order_id,
      session_id: entry.session_id,
      status: typeof entry.status === "string" ? entry.status : "",
      items: asLines(entry.items),
      total_usd: typeof entry.total_usd === "number" ? entry.total_usd : 0,
      created_at: typeof entry.created_at === "string" ? entry.created_at : undefined,
      cancelled_at: entry.cancelled_at === null || typeof entry.cancelled_at === "string" ? entry.cancelled_at : null,
    });
  }

  const observations: ShopObservation[] = [];
  for (const entry of value.observations) {
    if (!isRecord(entry) || typeof entry.session_id !== "string") continue;
    observations.push({
      session_id: entry.session_id,
      catalog_reads: arrayOf(entry.catalog_reads, (item) => {
        if (!isRecord(item) || typeof item.query !== "string") return undefined;
        return { query: item.query, at: typeof item.at === "string" ? item.at : undefined };
      }),
      product_views: arrayOf(entry.product_views, (item) => {
        if (!isRecord(item) || typeof item.product_id !== "string") return undefined;
        return { product_id: item.product_id, at: typeof item.at === "string" ? item.at : undefined };
      }),
      order_reads: arrayOf(entry.order_reads, (item) => {
        if (!isRecord(item) || typeof item.order_id !== "string") return undefined;
        return { order_id: item.order_id, at: typeof item.at === "string" ? item.at : undefined };
      }),
    });
  }

  return {
    carts,
    orders,
    inventory: Array.isArray(value.inventory) ? value.inventory : [],
    observations,
  };
}

function arrayOf<T>(value: unknown, map: (item: unknown) => T | undefined): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const mapped = map(item);
    return mapped === undefined ? [] : [mapped];
  });
}
