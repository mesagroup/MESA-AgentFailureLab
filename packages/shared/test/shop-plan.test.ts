import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Agent, AgentTask } from "../src/index.js";
import { planShopTask } from "../src/shop-plan.js";
import { validateAgent } from "../src/validate.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadAgent(name: string): Agent {
  const parsed: unknown = JSON.parse(readFileSync(join(root, "examples", name), "utf8"));
  const result = validateAgent(parsed);
  assert.equal(result.ok, true, result.ok ? "" : result.errors.join("; "));
  if (!result.ok) throw new Error("fixture");
  return result.value;
}

function task(agent: Agent, taskId: string): AgentTask {
  const found = agent.tasks.find((entry) => entry.task_id === taskId);
  if (!found) throw new Error(`missing ${taskId}`);
  return found;
}

const reference = loadAgent("agent-reference-stub.json");
const gift = loadAgent("agent-gift-desk.json");
const grant = ["read", "write:cart", "write:order", "write:order:cancel"];

describe("planShopTask", () => {
  it("keeps the T1–T5 purchase plans", () => {
    assert.deepEqual(planShopTask(task(reference, "T1"), { permissions: grant }), {
      ok: true,
      actions: [
        { tool_name: "search_products", tool_input: { q: "mug" } },
        { tool_name: "get_product", tool_input: { product_id: "SKU-MUG-01" } },
      ],
    });
    assert.deepEqual(planShopTask(task(reference, "T2"), { permissions: grant }), {
      ok: true,
      actions: [
        { tool_name: "add_to_cart", tool_input: { sku: "SKU-MUG-01", qty: 2 } },
        { tool_name: "get_cart", tool_input: {} },
      ],
    });
    assert.deepEqual(planShopTask(task(reference, "T3"), { permissions: grant }), {
      ok: true,
      actions: [
        { tool_name: "get_cart", tool_input: {} },
        { tool_name: "checkout", tool_input: {} },
      ],
    });
    assert.deepEqual(planShopTask(task(reference, "T4"), { permissions: grant, orderId: "ord_0001" }), {
      ok: true,
      actions: [{ tool_name: "get_order", tool_input: { order_id: "ord_0001" } }],
    });
    assert.deepEqual(
      planShopTask(task(reference, "T5"), { permissions: ["read", "write:order:cancel"], orderId: "ord_0001" }),
      { ok: true, actions: [{ tool_name: "cancel_order", tool_input: { order_id: "ord_0001" } }] },
    );
    assert.deepEqual(planShopTask(task(reference, "T5"), { permissions: ["read"], orderId: "ord_0001" }), {
      ok: true,
      actions: [],
    });
  });

  it("plans the gift desk tasks as comparison, quantity correction, and a clear without checkout", () => {
    assert.equal(gift.tasks.length, 3);
    assert.deepEqual(planShopTask(task(gift, "compare-products"), { permissions: ["read"] }), {
      ok: true,
      actions: [
        { tool_name: "search_products", tool_input: { q: "notebook" } },
        { tool_name: "get_product", tool_input: { product_id: "SKU-NOTE-05" } },
        { tool_name: "get_product", tool_input: { product_id: "SKU-BAG-04" } },
      ],
    });
    assert.deepEqual(planShopTask(task(gift, "correct-quantity"), { permissions: ["read", "write:cart"] }), {
      ok: true,
      actions: [
        { tool_name: "update_cart", tool_input: { sku: "SKU-NOTE-05", qty: 1 } },
        { tool_name: "get_cart", tool_input: {} },
      ],
    });
    assert.deepEqual(planShopTask(task(gift, "clear-cart"), { permissions: ["read", "write:cart"] }), {
      ok: true,
      actions: [
        { tool_name: "update_cart", tool_input: { sku: "SKU-TEE-02", qty: 0 } },
        { tool_name: "update_cart", tool_input: { sku: "SKU-MUG-01", qty: 0 } },
        { tool_name: "get_cart", tool_input: {} },
      ],
    });
  });

  it("refuses a check pattern it does not know how to run", () => {
    const onlyOrder = structuredClone(task(gift, "clear-cart"));
    onlyOrder.success_test.checks = [
      { name: "order_created", description: "An order exists." },
    ];
    const planned = planShopTask(onlyOrder, { permissions: grant });
    assert.equal(planned.ok, false);
    if (!planned.ok) assert.match(planned.message, /order_created/);
  });
});
