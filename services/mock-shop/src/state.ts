import { cloneSeedProducts, type Product } from "./catalog.js";

export interface CartLine {
  product_id: string;
  sku: string;
  name: string;
  qty: number;
  unit_price_usd: number;
}

export interface Cart {
  session_id: string;
  items: CartLine[];
  total_usd: number;
}

export interface Order {
  order_id: string;
  session_id: string;
  status: "placed" | "cancelled";
  items: CartLine[];
  total_usd: number;
  created_at: string;
  cancelled_at: string | null;
}

export interface SessionObservations {
  session_id: string;
  catalog_reads: Array<{ query: string; at: string }>;
  product_views: Array<{ product_id: string; at: string }>;
  order_reads: Array<{ order_id: string; at: string }>;
}

/** Body of `GET /internal/state`. This is the document to store as `mock_state_snapshot`. */
export interface ShopSnapshot {
  carts: Cart[];
  orders: Order[];
  inventory: Product[];
  observations: SessionObservations[];
}

export type ShopFailure =
  | { error: "not_found"; message: string }
  | { error: "invalid_request"; message: string }
  | {
      error: "insufficient_stock";
      message: string;
      sku: string;
      stock: number;
      requested_qty: number;
    }
  | { error: "conflict"; message: string };

export type ShopResult<T> = { ok: true; value: T } | { ok: false; failure: ShopFailure };

function usdFromCents(cents: number): number {
  return cents / 100;
}

function unitCents(priceUsd: number): number {
  return Math.round(priceUsd * 100);
}

function cartTotalUsd(items: readonly CartLine[]): number {
  const cents = items.reduce((sum, line) => sum + unitCents(line.unit_price_usd) * line.qty, 0);
  return usdFromCents(cents);
}

function formatOrderId(n: number): string {
  return `ord_${String(n).padStart(4, "0")}`;
}

function emptyObservations(sessionId: string): SessionObservations {
  return { session_id: sessionId, catalog_reads: [], product_views: [], order_reads: [] };
}

export class Shop {
  private products = cloneSeedProducts();
  private carts = new Map<string, Cart>();
  private orders = new Map<string, Order>();
  private observations = new Map<string, SessionObservations>();
  private nextOrder = 1;

  reset(): ShopSnapshot {
    this.products = cloneSeedProducts();
    this.carts = new Map();
    this.orders = new Map();
    this.observations = new Map();
    this.nextOrder = 1;
    return this.snapshot();
  }

  snapshot(): ShopSnapshot {
    return {
      carts: [...this.carts.values()].sort((a, b) => a.session_id.localeCompare(b.session_id)),
      orders: [...this.orders.values()].sort((a, b) => a.order_id.localeCompare(b.order_id)),
      inventory: [...this.products.values()].sort((a, b) => a.product_id.localeCompare(b.product_id)),
      observations: [...this.observations.values()].sort((a, b) =>
        a.session_id.localeCompare(b.session_id),
      ),
    };
  }

  search(sessionId: string, query: string): Product[] {
    this.observe(sessionId).catalog_reads.push({ query, at: new Date().toISOString() });
    const needle = query.toLowerCase();
    return [...this.products.values()]
      .filter((product) => {
        if (needle.length === 0) return true;
        return [product.product_id, product.sku, product.name, product.description]
          .join("\n")
          .toLowerCase()
          .includes(needle);
      })
      .sort((a, b) => a.product_id.localeCompare(b.product_id));
  }

  getProduct(sessionId: string, productId: string): ShopResult<Product> {
    const product = this.products.get(productId);
    if (!product) {
      return { ok: false, failure: { error: "not_found", message: `Unknown product ${productId}` } };
    }
    this.observe(sessionId).product_views.push({
      product_id: product.product_id,
      at: new Date().toISOString(),
    });
    return { ok: true, value: product };
  }

  getCart(sessionId: string): Cart {
    return this.carts.get(sessionId) ?? { session_id: sessionId, items: [], total_usd: 0 };
  }

  addToCart(sessionId: string, sku: string, qty: number): ShopResult<Cart> {
    const product = this.products.get(sku);
    if (!product) {
      return { ok: false, failure: { error: "not_found", message: `Unknown product ${sku}` } };
    }
    const cart = this.ensureCart(sessionId);
    const existing = cart.items.find((line) => line.sku === sku);
    const nextQty = (existing?.qty ?? 0) + qty;
    if (nextQty > product.stock) {
      return {
        ok: false,
        failure: {
          error: "insufficient_stock",
          message: `${sku} has ${product.stock} in stock; the cart would need ${nextQty}.`,
          sku,
          stock: product.stock,
          requested_qty: nextQty,
        },
      };
    }
    if (existing) {
      existing.qty = nextQty;
    } else {
      cart.items.push({
        product_id: product.product_id,
        sku: product.sku,
        name: product.name,
        qty,
        unit_price_usd: product.price_usd,
      });
    }
    cart.total_usd = cartTotalUsd(cart.items);
    return { ok: true, value: cart };
  }

  updateCart(sessionId: string, sku: string, qty: number): ShopResult<Cart> {
    const cart = this.carts.get(sessionId);
    const existing = cart?.items.find((line) => line.sku === sku);
    if (!cart || !existing) {
      return { ok: false, failure: { error: "not_found", message: `Cart has no line for ${sku}` } };
    }
    if (qty === 0) {
      cart.items = cart.items.filter((line) => line.sku !== sku);
      cart.total_usd = cartTotalUsd(cart.items);
      return { ok: true, value: cart };
    }
    const product = this.products.get(sku);
    const stock = product?.stock ?? 0;
    if (qty > stock) {
      return {
        ok: false,
        failure: {
          error: "insufficient_stock",
          message: `${sku} has ${stock} in stock; the cart would need ${qty}.`,
          sku,
          stock,
          requested_qty: qty,
        },
      };
    }
    existing.qty = qty;
    cart.total_usd = cartTotalUsd(cart.items);
    return { ok: true, value: cart };
  }

  checkout(sessionId: string): ShopResult<Order> {
    const cart = this.carts.get(sessionId);
    if (!cart || cart.items.length === 0) {
      return { ok: false, failure: { error: "invalid_request", message: "Cart is empty." } };
    }
    for (const line of cart.items) {
      const product = this.products.get(line.sku);
      const stock = product?.stock ?? 0;
      if (!product || line.qty > stock) {
        return {
          ok: false,
          failure: {
            error: "insufficient_stock",
            message: `${line.sku} has ${stock} in stock; checkout needs ${line.qty}.`,
            sku: line.sku,
            stock,
            requested_qty: line.qty,
          },
        };
      }
    }
    for (const line of cart.items) {
      const product = this.products.get(line.sku);
      if (product) product.stock -= line.qty;
    }
    const order: Order = {
      order_id: formatOrderId(this.nextOrder),
      session_id: sessionId,
      status: "placed",
      items: cart.items.map((line) => ({ ...line })),
      total_usd: cart.total_usd,
      created_at: new Date().toISOString(),
      cancelled_at: null,
    };
    this.nextOrder += 1;
    this.orders.set(order.order_id, order);
    cart.items = [];
    cart.total_usd = 0;
    return { ok: true, value: order };
  }

  getOrder(sessionId: string, orderId: string): ShopResult<Order> {
    const order = this.orders.get(orderId);
    if (!order) {
      return { ok: false, failure: { error: "not_found", message: `Unknown order ${orderId}` } };
    }
    this.observe(sessionId).order_reads.push({ order_id: order.order_id, at: new Date().toISOString() });
    return { ok: true, value: order };
  }

  cancelOrder(orderId: string): ShopResult<Order> {
    const order = this.orders.get(orderId);
    if (!order) {
      return { ok: false, failure: { error: "not_found", message: `Unknown order ${orderId}` } };
    }
    if (order.status === "cancelled") {
      return { ok: false, failure: { error: "conflict", message: `Order ${orderId} is already cancelled.` } };
    }
    order.status = "cancelled";
    order.cancelled_at = new Date().toISOString();
    for (const line of order.items) {
      const product = this.products.get(line.sku);
      if (product) product.stock += line.qty;
    }
    return { ok: true, value: order };
  }

  private ensureCart(sessionId: string): Cart {
    const existing = this.carts.get(sessionId);
    if (existing) return existing;
    const cart: Cart = { session_id: sessionId, items: [], total_usd: 0 };
    this.carts.set(sessionId, cart);
    return cart;
  }

  private observe(sessionId: string): SessionObservations {
    const existing = this.observations.get(sessionId);
    if (existing) return existing;
    const created = emptyObservations(sessionId);
    this.observations.set(sessionId, created);
    return created;
  }
}

export function createShop(): Shop {
  return new Shop();
}
