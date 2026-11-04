import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentTask } from "@mesa/shared";
import { loadReferenceAgent } from "../src/reference-agent.js";
import { prepareWorld } from "../src/harness/world.js";
import { withWorldGate } from "../src/harness/world-gate.js";
import type { MockShopClient, ShopRequest } from "../src/mock/client.js";

const reference = loadReferenceAgent();

function task(taskId: string): AgentTask {
  const found = reference.tasks.find((entry) => entry.task_id === taskId);
  if (!found) throw new Error(taskId);
  return found;
}

function recordingClient(): MockShopClient & { calls: ShopRequest[] } {
  const calls: ShopRequest[] = [];
  return {
    calls,
    async reset() {
      return { raw: {}, parsed: { carts: [], orders: [], inventory: [], observations: [] } };
    },
    async state() {
      throw new Error("state is not part of setup");
    },
    async request(options) {
      calls.push(options);
      if (options.path === "/checkout") return { status: 201, body: { order_id: `ord_${calls.length}` } };
      return { status: 200, body: { ok: true } };
    },
  };
}

describe("prepareWorld", () => {
  it("resets and does nothing else when setup is empty", async () => {
    const client = recordingClient();
    const prepared = await withWorldGate(() => prepareWorld(task("T1"), client, "sess-a"));
    assert.deepEqual(prepared, {});
    assert.deepEqual(client.calls, []);
  });

  it("seeds the cart from setup and checks out each requested order", async () => {
    const client = recordingClient();
    const custom: AgentTask = {
      ...task("T4"),
      task_id: "seed-cap",
      setup: {
        cart: [{ sku: "SKU-CAP-03", qty: 1 }],
        orders: [{ from_cart: true }],
        permissions: ["read"],
      },
    };
    const prepared = await withWorldGate(() => prepareWorld(custom, client, "sess-cap"));
    assert.equal(prepared.orderId, "ord_2");
    assert.deepEqual(
      client.calls.map((call) => ({ path: call.path, body: call.body, permissions: call.permissions })),
      [
        { path: "/cart/items", body: { sku: "SKU-CAP-03", qty: 1 }, permissions: ["write:cart"] },
        { path: "/checkout", body: undefined, permissions: ["write:order"] },
      ],
    );
  });

  it("uses the seeded task's cart for checkout tasks and does not check out", async () => {
    const client = recordingClient();
    const prepared = await withWorldGate(() => prepareWorld(task("T3"), client, "sess-t3"));
    assert.equal(prepared.orderId, undefined);
    assert.deepEqual(client.calls.map((call) => call.path), ["/cart/items"]);
    assert.deepEqual(client.calls[0]?.body, { sku: "SKU-MUG-01", qty: 2 });
  });
});
