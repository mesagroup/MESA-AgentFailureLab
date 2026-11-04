import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

const session = { "x-session-id": "demo" };

function allow(...permissions: string[]): Record<string, string> {
  return { ...session, "x-permissions": permissions.join(",") };
}

async function withApp(run: (app: FastifyInstance) => Promise<void>): Promise<void> {
  const app = buildApp();
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

describe("mock shop", () => {
  it("requires read to search and records the catalog read", async () => {
    await withApp(async (app) => {
      const denied = await app.inject({ method: "GET", url: "/products?q=mug", headers: session });
      assert.equal(denied.statusCode, 403);
      assert.equal(denied.json().error, "permission_denied");
      assert.equal(denied.json().required, "read");

      const found = await app.inject({
        method: "GET",
        url: "/products?q=mug",
        headers: allow("read"),
      });
      assert.equal(found.statusCode, 200);
      assert.deepEqual(
        found.json().products.map((product: { sku: string }) => product.sku),
        ["SKU-MUG-01"],
      );

      const state = await app.inject({ method: "GET", url: "/internal/state" });
      assert.equal(state.statusCode, 200);
      assert.equal(state.json().observations[0].catalog_reads[0].query, "mug");
    });
  });

  it("opens a product and adds it to the cart", async () => {
    await withApp(async (app) => {
      const product = await app.inject({
        method: "GET",
        url: "/products/SKU-MUG-01",
        headers: allow("read"),
      });
      assert.equal(product.statusCode, 200);
      assert.equal(product.json().product_id, "SKU-MUG-01");
      assert.equal(product.json().price_usd, 12);

      const missingWrite = await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { ...allow("read"), "content-type": "application/json" },
        payload: { sku: "SKU-MUG-01", qty: 2 },
      });
      assert.equal(missingWrite.statusCode, 403);
      assert.equal(missingWrite.json().required, "write:cart");

      const added = await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { ...allow("read", "write:cart"), "content-type": "application/json" },
        payload: { sku: "SKU-MUG-01", qty: 2 },
      });
      assert.equal(added.statusCode, 200);
      assert.equal(added.json().total_usd, 24);
      assert.equal(added.json().items[0].qty, 2);

      const state = await app.inject({ method: "GET", url: "/internal/state" });
      const body = state.json();
      assert.equal(body.observations[0].product_views[0].product_id, "SKU-MUG-01");
      assert.equal(body.carts[0].items[0].sku, "SKU-MUG-01");
      assert.equal(body.inventory.find((item: { sku: string }) => item.sku === "SKU-MUG-01").stock, 20);
    });
  });

  it("updates a cart line and removes it when qty is 0", async () => {
    await withApp(async (app) => {
      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { ...allow("write:cart"), "content-type": "application/json" },
        payload: { sku: "SKU-CAP-03", qty: 1 },
      });

      const denied = await app.inject({
        method: "PATCH",
        url: "/cart/items/SKU-CAP-03",
        headers: { ...allow("read"), "content-type": "application/json" },
        payload: { qty: 3 },
      });
      assert.equal(denied.statusCode, 403);
      assert.equal(denied.json().required, "write:cart");

      const updated = await app.inject({
        method: "PATCH",
        url: "/cart/items/SKU-CAP-03",
        headers: { ...allow("write:cart"), "content-type": "application/json" },
        payload: { qty: 3 },
      });
      assert.equal(updated.statusCode, 200);
      assert.equal(updated.json().items[0].qty, 3);
      assert.equal(updated.json().total_usd, 54);

      const removed = await app.inject({
        method: "PATCH",
        url: "/cart/items/SKU-CAP-03",
        headers: { ...allow("write:cart"), "content-type": "application/json" },
        payload: { qty: 0 },
      });
      assert.equal(removed.statusCode, 200);
      assert.deepEqual(removed.json().items, []);
      assert.equal(removed.json().total_usd, 0);
    });
  });

  it("creates an order on checkout and empties the cart", async () => {
    await withApp(async (app) => {
      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { ...allow("write:cart"), "content-type": "application/json" },
        payload: { sku: "SKU-MUG-01", qty: 2 },
      });

      const denied = await app.inject({
        method: "POST",
        url: "/checkout",
        headers: allow("write:cart"),
      });
      assert.equal(denied.statusCode, 403);
      assert.equal(denied.json().error, "permission_denied");
      assert.equal(denied.json().required, "write:order");

      const created = await app.inject({
        method: "POST",
        url: "/checkout",
        headers: allow("write:cart", "write:order"),
      });
      assert.equal(created.statusCode, 201);
      const order = created.json();
      assert.equal(order.order_id, "ord_0001");
      assert.equal(order.status, "placed");
      assert.equal(order.total_usd, 24);
      assert.equal(order.items[0].qty, 2);

      const cart = await app.inject({ method: "GET", url: "/cart", headers: allow("read") });
      assert.deepEqual(cart.json().items, []);

      const state = await app.inject({ method: "GET", url: "/internal/state" });
      const body = state.json();
      assert.equal(body.orders.length, 1);
      assert.equal(body.orders[0].order_id, "ord_0001");
      assert.equal(body.carts[0].items.length, 0);
      assert.equal(body.inventory.find((item: { sku: string }) => item.sku === "SKU-MUG-01").stock, 18);

      const read = await app.inject({
        method: "GET",
        url: "/orders/ord_0001",
        headers: allow("read"),
      });
      assert.equal(read.statusCode, 200);
      assert.equal(read.json().status, "placed");
    });
  });

  it("refuses cancel without write:order:cancel and cancels with it", async () => {
    await withApp(async (app) => {
      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { ...allow("write:cart"), "content-type": "application/json" },
        payload: { product_id: "SKU-NOTE-05", qty: 1 },
      });
      await app.inject({
        method: "POST",
        url: "/checkout",
        headers: allow("write:order"),
      });

      const denied = await app.inject({
        method: "POST",
        url: "/orders/ord_0001/cancel",
        headers: allow("read", "write:cart", "write:order"),
      });
      assert.equal(denied.statusCode, 403);
      assert.deepEqual(denied.json(), {
        error: "permission_denied",
        required: "write:order:cancel",
        granted: ["read", "write:cart", "write:order"],
        message: "Missing permission write:order:cancel",
      });

      const stillPlaced = await app.inject({ method: "GET", url: "/internal/state" });
      assert.equal(stillPlaced.json().orders[0].status, "placed");
      assert.equal(
        stillPlaced.json().inventory.find((item: { sku: string }) => item.sku === "SKU-NOTE-05").stock,
        29,
      );

      const cancelled = await app.inject({
        method: "POST",
        url: "/orders/ord_0001/cancel",
        headers: allow("write:order:cancel"),
      });
      assert.equal(cancelled.statusCode, 200);
      assert.equal(cancelled.json().status, "cancelled");
      assert.ok(cancelled.json().cancelled_at);

      const after = await app.inject({ method: "GET", url: "/internal/state" });
      assert.equal(after.json().orders[0].status, "cancelled");
      assert.equal(
        after.json().inventory.find((item: { sku: string }) => item.sku === "SKU-NOTE-05").stock,
        30,
      );
    });
  });

  it("resets carts, orders, and stock", async () => {
    await withApp(async (app) => {
      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { ...allow("write:cart"), "content-type": "application/json" },
        payload: { sku: "SKU-MUG-01", qty: 1 },
      });
      await app.inject({ method: "POST", url: "/checkout", headers: allow("write:order") });

      const reset = await app.inject({ method: "POST", url: "/internal/reset" });
      assert.equal(reset.statusCode, 200);
      const body = reset.json();
      assert.deepEqual(body.carts, []);
      assert.deepEqual(body.orders, []);
      assert.equal(body.inventory.find((item: { sku: string }) => item.sku === "SKU-MUG-01").stock, 20);
      assert.equal(body.inventory.length, 5);
    });
  });

  it("rejects an unknown permission token", async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/cart",
        headers: { ...session, "x-permissions": "read,admin" },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error, "invalid_request");
    });
  });
});
