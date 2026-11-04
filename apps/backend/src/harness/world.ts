import type { AgentTask } from "@mesa/shared";
import type { MockShopClient } from "../mock/client.js";
import { assertWorldGateHeld } from "./world-gate.js";

/**
 * Harness-side world setup. These calls are not agent steps and are not injected.
 * Shop tasks seed cart lines, then one checkout per seeded order.
 * Library tasks seed `setup.library.loans` and do not touch the shop cart.
 * The last shop checkout's `order_id` is returned for the agent request.
 *
 * `reset` clears the mock. Callers hold the world gate before this function and
 * keep it through the snapshot, the verifier, and the result save.
 */
export async function prepareWorld(
  task: AgentTask,
  client: MockShopClient,
  sessionId: string,
): Promise<{ orderId?: string }> {
  assertWorldGateHeld();
  if (task.setup.library) {
    await client.reset();
    const seeded = await client.request({
      method: "POST",
      path: "/internal/seed",
      sessionId,
      permissions: ["read", "write:loan", "write:hold"],
      body: { loans: task.setup.library.loans },
    });
    if (seeded.status >= 400) {
      throw new Error(`Seeding the library failed with ${seeded.status}.`);
    }
    return {};
  }
  await client.reset();
  for (const line of task.setup.cart) {
    const added = await client.request({
      method: "POST",
      path: "/cart/items",
      sessionId,
      permissions: ["write:cart"],
      body: { sku: line.sku, qty: line.qty },
    });
    if (added.status >= 400) {
      throw new Error(`Seeding the cart failed with ${added.status}.`);
    }
  }

  let orderId: string | undefined;
  for (const order of task.setup.orders) {
    if (!order.from_cart) continue;
    const created = await client.request({
      method: "POST",
      path: "/checkout",
      sessionId,
      permissions: ["write:order"],
    });
    if (created.status >= 400) {
      throw new Error(`Seeding the order failed with ${created.status}.`);
    }
    const seeded = readOrderId(created.body);
    if (!seeded) throw new Error("Seeding the order returned no order_id.");
    orderId = seeded;
  }
  return orderId === undefined ? {} : { orderId };
}

function readOrderId(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("order_id" in body)) return undefined;
  const orderId = body.order_id;
  return typeof orderId === "string" && orderId.length > 0 ? orderId : undefined;
}
