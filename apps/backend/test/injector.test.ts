import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FAULT_CATEGORIES, type InjectionPlan } from "@mesa/shared";
import { scriptedActions } from "../src/agent/scripted.js";
import { executeAttempt } from "../src/harness/execute.js";
import {
  FAULT_CATALOG,
  droppedOutput,
  faultByCode,
  forgedOutput,
  mutatedInput,
  normalizePlan,
  presetPlan,
  staleOutput,
  type FaultDefinition,
} from "../src/injector/catalog.js";
import {
  NEUTRAL_TIMEOUT_MESSAGE,
  scrubSpoilers,
  spoilerMarkersIn,
  type SpoilerMarkerId,
} from "../src/injector/spoilers.js";
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
    assert.deepEqual(spoilerMarkersIn(execution.steps), []);
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
    assert.deepEqual(spoilerMarkersIn(execution.steps), []);
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
    assert.deepEqual(spoilerMarkersIn(execution.steps), []);
  });
});

describe("injector payloads visible to the model", () => {
  it("flags historical spoiler markers and strips them", () => {
    const planted = {
      content: "Injector skipped search_products.",
      missed: "Injector target checkout was not called.",
      tool_output: {
        forged: true,
        stale: false,
        injected: true,
        status: "placed",
        message: "Injected execution drop before the mock was called.",
      },
      inline: "forged:true stale: true injected:false",
    };
    const hits = spoilerMarkersIn(planted);
    const expected: SpoilerMarkerId[] = [
      "Injected",
      "Injector skipped",
      "Injector target",
      "forged:true",
      "stale:true",
      "stale:false",
      "injected:true",
      "injected:false",
    ];
    for (const marker of expected) {
      assert.equal(hits.includes(marker), true, marker);
    }
    const clean = scrubSpoilers(planted);
    assert.deepEqual(spoilerMarkersIn(clean), []);
    assert.equal(clean.tool_output.status, "placed");
    assert.equal(clean.tool_output.message, NEUTRAL_TIMEOUT_MESSAGE);
    assert.equal("forged" in clean.tool_output, false);
    assert.equal("stale" in clean.tool_output, false);
    assert.equal("injected" in clean.tool_output, false);
  });

  it("builders keep the fault and omit spoiler markers", () => {
    const forged = forgedOutput("search_products", { q: "mug" });
    assert.deepEqual(spoilerMarkersIn(forged), []);
    assert.equal(Object.hasOwn(forged as object, "forged"), false);
    assert.deepEqual(forgedOutput("checkout", {}), { order_id: "ord_fake", status: "placed", total_usd: 24 });
    assert.deepEqual(forgedOutput("cancel_order", { order_id: "ord_9" }), {
      order_id: "ord_9",
      status: "cancelled",
    });
    assert.deepEqual(spoilerMarkersIn(forgedOutput("get_cart", {})), []);

    const staleProduct = staleOutput("get_product", { product_id: "SKU-MUG-01", stock: 20, name: "Ceramic Mug" });
    assert.equal(Object.hasOwn(staleProduct as object, "stale"), false);
    assert.equal((staleProduct as { stock: number }).stock, 19);
    assert.equal((staleProduct as { name: string }).name, "Ceramic Mug");

    const staleOrder = staleOutput("get_order", { order_id: "ord_1", status: "placed" });
    assert.equal((staleOrder as { status: string }).status, "cancelled");
    assert.deepEqual(spoilerMarkersIn(staleOrder), []);
    assert.deepEqual(spoilerMarkersIn(staleOutput("get_product", "not-json")), []);

    const mutated = mutatedInput({ q: "mug" });
    assert.deepEqual(mutated, { q: "mug-x" });
    assert.equal(Object.hasOwn(mutated, "injected"), false);
    assert.deepEqual(mutatedInput({ sku: "SKU-MUG-01", qty: 2 }), { sku: "SKU-MUG-01", qty: 1 });
    assert.equal(Object.hasOwn(mutatedInput({}), "injected"), false);

    const dropped = droppedOutput();
    assert.equal(dropped.error, "timeout");
    assert.equal(dropped.message, NEUTRAL_TIMEOUT_MESSAGE);
    assert.deepEqual(spoilerMarkersIn(dropped), []);
  });

  it("injected steps keep labels and hide spoilers from model-visible fields", async () => {
    const read = ["read"];
    const cases: Array<{
      name: string;
      code: string;
      target?: string;
      taskId: string;
      actions: ReturnType<typeof scriptedActions>;
      permissions: string[];
      body: (path: string) => unknown;
      expect: (execution: Awaited<ReturnType<typeof executeAttempt>>, paths: string[]) => void;
    }> = [
      {
        name: "skip",
        code: "omitted_required_step",
        taskId: "T1",
        actions: scriptedActions("T1", { permissions: read }),
        permissions: read,
        body: () => ({ products: [] }),
        expect: (execution, paths) => {
          assert.deepEqual(paths, ["/products/SKU-MUG-01"]);
          assert.equal(execution.steps.some((step) => step.type === "system"), false);
          assert.equal(execution.labels[0]?.step_id, "step-1");
          assert.equal(execution.steps.find((step) => step.step_id === "step-1")?.tool_name, "get_product");
        },
      },
      {
        name: "forge fallback",
        code: "forged_tool_result",
        target: "search_products",
        taskId: "T1",
        actions: scriptedActions("T1", { permissions: read }),
        permissions: read,
        body: () => ({ product_id: "SKU-MUG-01", stock: 20 }),
        expect: (execution, paths) => {
          assert.deepEqual(paths, ["/products/SKU-MUG-01"]);
          const labeled = execution.steps.find((step) => step.step_id === execution.labels[0]?.step_id);
          assert.equal(labeled?.type, "tool_result");
          assert.equal(Object.hasOwn(labeled?.tool_output as object, "forged"), false);
        },
      },
      {
        name: "stale fallback",
        code: "stale_tool_result",
        target: "get_product",
        taskId: "T1",
        actions: scriptedActions("T1", { permissions: read }),
        permissions: read,
        body: () => ({ product_id: "SKU-MUG-01", stock: 20, name: "Ceramic Mug" }),
        expect: (execution, paths) => {
          assert.deepEqual(paths, ["/products?q=mug", "/products/SKU-MUG-01"]);
          const labeled = execution.steps.find((step) => step.step_id === execution.labels[0]?.step_id);
          assert.equal((labeled?.tool_output as { stock?: number }).stock, 19);
          assert.equal(Object.hasOwn(labeled?.tool_output as object, "stale"), false);
        },
      },
      {
        name: "mutate fallback",
        code: "wrong_argument",
        target: "search_products",
        taskId: "T1",
        actions: scriptedActions("T1", { permissions: read }),
        permissions: read,
        body: () => ({ products: [] }),
        expect: (execution, paths) => {
          assert.equal(paths[0], "/products?q=mug-x");
          const labeled = execution.steps.find((step) => step.step_id === execution.labels[0]?.step_id);
          assert.deepEqual(labeled?.tool_input, { q: "mug-x" });
          assert.equal(Object.hasOwn(labeled?.tool_input as object, "injected"), false);
        },
      },
      {
        name: "drop",
        code: "dropped_tool_call",
        taskId: "T3",
        actions: scriptedActions("T3", { permissions: ["read", "write:order"] }),
        permissions: ["read", "write:order"],
        body: () => ({ items: [], total_usd: 0 }),
        expect: (execution, paths) => {
          assert.deepEqual(paths, ["/cart"]);
          const labeled = execution.steps.find((step) => step.step_id === execution.labels[0]?.step_id);
          assert.deepEqual(labeled?.tool_output, { error: "timeout", message: NEUTRAL_TIMEOUT_MESSAGE });
          assert.equal(execution.claimedSuccess, false);
        },
      },
      {
        name: "missed target",
        code: "forged_permission_success",
        taskId: "T1",
        actions: scriptedActions("T1", { permissions: read }),
        permissions: read,
        body: () => ({ products: [] }),
        expect: (execution, paths) => {
          assert.deepEqual(paths, ["/products?q=mug", "/products/SKU-MUG-01"]);
          assert.equal(execution.steps.some((step) => step.type === "system"), false);
          const labeled = execution.steps.find((step) => step.step_id === execution.labels[0]?.step_id);
          assert.equal(labeled?.type, "message");
          assert.equal(labeled?.role, "assistant");
          assert.equal(labeled?.content?.includes("Injector"), false);
        },
      },
    ];

    for (const item of cases) {
      const entry = faultByCode(item.code);
      const client = recordingClient((path) => ({ status: 200, body: item.body(path) }));
      const execution = await executeAttempt({
        prompt: "Run the task.",
        taskId: item.taskId,
        actions: item.actions,
        client,
        sessionId: "sess-a",
        permissions: item.permissions,
        plan: {
          fault: entry.fault,
          target: item.target ?? entry.target,
          ground_truth: { category: entry.category, code: entry.code },
        },
        timeoutMs: 30_000,
        startedMs: Date.now(),
      });
      assert.equal(execution.labels.length, 1, item.name);
      assert.equal(execution.labels[0]?.code, entry.code, item.name);
      assert.equal(execution.labels[0]?.category, entry.category, item.name);
      assert.equal(
        execution.steps.some((step) => step.step_id === execution.labels[0]?.step_id),
        true,
        item.name,
      );
      assert.deepEqual(spoilerMarkersIn(execution.steps), [], item.name);
      assert.deepEqual(spoilerMarkersIn(execution.labels), [], item.name);
      item.expect(execution, client.paths);
    }
  });
});
