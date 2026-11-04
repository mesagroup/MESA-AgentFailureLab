import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { TASK_EVALSET_VERSION, type Agent, type AgentTask } from "../src/index.js";
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
const grant = ["read", "write:cart", "write:order", "write:order:cancel"];

describe("planShopTask", () => {
  it("keeps the T1–T5 purchase plans", () => {
    assert.equal(task(reference, "T1").evalset?.version, TASK_EVALSET_VERSION);
    assert.equal(task(reference, "T2").evalset, undefined);
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

  it("refuses a check pattern it does not know how to run", () => {
    const onlyEmpty = structuredClone(task(reference, "T2"));
    onlyEmpty.success_test.checks = [{ name: "cart_empty", description: "The cart is empty." }];
    const planned = planShopTask(onlyEmpty, { permissions: grant });
    assert.equal(planned.ok, false);
    if (!planned.ok) assert.match(planned.message, /cart_empty/);
  });
});
