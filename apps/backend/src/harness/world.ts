import type { MockShopClient } from "../mock/client.js";

/** Harness-side world setup. These calls are not agent steps and are not injected. */
export async function prepareWorld(
  taskId: string,
  client: MockShopClient,
  sessionId: string,
): Promise<{ orderId?: string }> {
  await client.reset();
  if (taskId !== "T3" && taskId !== "T4" && taskId !== "T5") {
    return {};
  }

  const added = await client.request({
    method: "POST",
    path: "/cart/items",
    sessionId,
    permissions: ["write:cart"],
    body: { sku: "SKU-MUG-01", qty: 2 },
  });
  if (added.status >= 400) {
    throw new Error(`Seeding the cart failed with ${added.status}.`);
  }
  if (taskId === "T3") return {};

  const created = await client.request({
    method: "POST",
    path: "/checkout",
    sessionId,
    permissions: ["write:order"],
  });
  if (created.status >= 400) {
    throw new Error(`Seeding the order failed with ${created.status}.`);
  }
  const orderId =
    typeof created.body === "object" &&
    created.body !== null &&
    "order_id" in created.body &&
    typeof created.body.order_id === "string"
      ? created.body.order_id
      : "";
  if (orderId.length === 0) {
    throw new Error("Seeding the order returned no order_id.");
  }
  return { orderId };
}
