import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FAULT_CATEGORIES, type InjectionPlan } from "@mesa/shared";
import { scriptedActions } from "../src/agent/scripted.js";
import { executeAttempt } from "../src/harness/execute.js";
import {
  FAULT_CATALOG,
  normalizePlan,
  presetPlan,
  type FaultDefinition,
} from "../src/injector/catalog.js";
import type { MockShopClient, ShopResponse, ShopState } from "../src/mock/client.js";

function emptyState(): ShopState {
  const raw = { carts: [], orders: [], inventory: [], observations: [] };
  return { raw, parsed: { carts: [], orders: [], inventory: [], observations: [] } };
}

function recordingClient(onRequest: (path: string, body: unknown) => ShopResponse): MockShopClient & { paths: string[] } {
  return {
    paths: [],
    async reset() {
      return emptyState();
    },
    async state() {
      return emptyState();
    },
    async request(options) {
      this.paths.push(options.path);
      return onRequest(options.path, options.body);
    },
  };
}

describe("fault catalog", () => {
  it("covers every diagnosis category and the T1–T5 presets", () => {
    assert.deepEqual(
      FAULT_CATALOG.map((entry) => entry.category),
      [...FAULT_CATEGORIES],
    );
    const codes = new Set(FAULT_CATALOG.map((entry) => entry.code));
    for (const taskId of ["T1", "T2", "T3", "T4", "T5"]) {
      const plan = presetPlan(taskId);
      assert.equal(codes.has(plan.ground_truth.code), true);
      assert.equal(plan.ground_truth.step_id, undefined);
      const entry = FAULT_CATALOG.find((item) => item.code === plan.ground_truth.code) as FaultDefinition;
      assert.equal(plan.ground_truth.category, entry.category);
      assert.equal(plan.target, entry.target);
    }
  });

  it("rejects a plan whose category does not match the code", () => {
    assert.throws(
      () =>
        normalizePlan({
          fault: "Forge checkout.",
          target: "checkout",
          ground_truth: { category: "Security", code: "forged_tool_result" },
        }),
      /belongs to ToolUse/,
    );
  });
});

describe("injector", () => {
  it("forges checkout without calling the mock and labels the tool result", async () => {
    const client = recordingClient(() => ({ status: 200, body: { items: [], total_usd: 0 } }));
    const plan: InjectionPlan = presetPlan("T3");
    const execution = await executeAttempt({
      prompt: "Check out the current cart.",
      taskId: "T3",
      actions: scriptedActions("T3", { permissions: ["read", "write:order"] }),
      client,
      sessionId: "sess-a",
      permissions: ["read", "write:order"],
      plan,
      timeoutMs: 30_000,
      startedMs: Date.now(),
    });

    assert.deepEqual(client.paths, ["/cart"]);
    assert.equal(execution.labels.length, 1);
    assert.equal(execution.labels[0]?.category, "ToolUse");
    assert.equal(execution.labels[0]?.code, "forged_tool_result");
    const labeled = execution.steps.find((step) => step.step_id === execution.labels[0]?.step_id);
    assert.equal(labeled?.type, "tool_result");
    assert.equal(labeled?.tool_name, "checkout");
    assert.deepEqual(labeled?.tool_output, { order_id: "ord_fake", status: "placed", total_usd: 24 });
    assert.equal(execution.claimedSuccess, true);
  });

  it("rewrites add_to_cart quantity and labels the tool call", async () => {
    const seen: unknown[] = [];
    const client = recordingClient((path, body) => {
      seen.push(body);
      if (path === "/cart/items") return { status: 200, body: { items: [{ sku: "SKU-MUG-01", qty: 1 }] } };
      return { status: 200, body: { items: [{ sku: "SKU-MUG-01", qty: 1 }], total_usd: 12 } };
    });
    const execution = await executeAttempt({
      prompt: "Add 2 units.",
      taskId: "T2",
      actions: scriptedActions("T2", { permissions: ["read", "write:cart"] }),
      client,
      sessionId: "sess-a",
      permissions: ["read", "write:cart"],
      plan: presetPlan("T2"),
      timeoutMs: 30_000,
      startedMs: Date.now(),
    });
    assert.deepEqual(seen[0], { sku: "SKU-MUG-01", qty: 1 });
    assert.equal(execution.labels[0]?.category, "Reasoning");
    assert.equal(execution.labels[0]?.code, "wrong_argument");
    const labeled = execution.steps.find((step) => step.step_id === execution.labels[0]?.step_id);
    assert.equal(labeled?.type, "tool_call");
    assert.deepEqual(labeled?.tool_input, { sku: "SKU-MUG-01", qty: 1 });
  });

  it("writes no labels when there is no plan", async () => {
    const client = recordingClient(() => ({ status: 200, body: { products: [] } }));
    const execution = await executeAttempt({
      prompt: "Search.",
      taskId: "T1",
      actions: scriptedActions("T1", { permissions: ["read"] }),
      client,
      sessionId: "sess-a",
      permissions: ["read"],
      plan: null,
      timeoutMs: 30_000,
      startedMs: Date.now(),
    });
    assert.deepEqual(execution.labels, []);
    assert.deepEqual(client.paths, ["/products?q=mug", "/products/SKU-MUG-01"]);
  });
});
