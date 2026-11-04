import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { InjectionPlan } from "@mesa/shared";
import { scriptedActions } from "../src/agent/scripted.js";
import { executeAttempt } from "../src/harness/execute.js";
import { backoffMs, retryDecision, TRANSIENT_STATUSES } from "../src/harness/retry.js";
import { droppedOutput } from "../src/injector/catalog.js";
import type { MockShopClient, ShopResponse } from "../src/mock/client.js";
import { verifyOutcome } from "../src/verifier/verify.js";
import { loadReferenceAgent } from "../src/reference-agent.js";

const reference = loadReferenceAgent();

function emptyState() {
  const raw = { carts: [], orders: [], inventory: [], observations: [] };
  return { raw, parsed: { carts: [], orders: [], inventory: [], observations: [] } };
}

function sequenceClient(responses: ShopResponse[]): MockShopClient & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async reset() {
      return emptyState();
    },
    async state() {
      return emptyState();
    },
    async request() {
      const response = responses[Math.min(calls, responses.length - 1)];
      calls += 1;
      if (response === undefined) return { status: 500, body: { error: "error" } };
      return response;
    },
  };
}

describe("retry decision", () => {
  it("retries a read and stops a dispatched mutate, with at most two retries", () => {
    assert.equal(
      retryDecision({
        tool: "get_order",
        dispatched: true,
        completedAttempts: 1,
        maxRetries: 2,
        fixes: ["controlled_retry"],
      }),
      "retry",
    );
    assert.equal(
      retryDecision({
        tool: "checkout",
        dispatched: true,
        completedAttempts: 1,
        maxRetries: 2,
        fixes: ["controlled_retry"],
      }),
      "stop",
    );
    assert.equal(
      retryDecision({
        tool: "checkout",
        dispatched: false,
        completedAttempts: 1,
        maxRetries: 2,
        fixes: ["controlled_retry"],
      }),
      "retry",
    );
    assert.equal(
      retryDecision({
        tool: "get_order",
        dispatched: true,
        completedAttempts: 3,
        maxRetries: 2,
        fixes: ["controlled_retry"],
      }),
      "stop",
    );
    assert.equal(
      retryDecision({
        tool: "get_order",
        dispatched: false,
        completedAttempts: 1,
        maxRetries: 2,
        fixes: [],
      }),
      "stop",
    );
    assert.equal(backoffMs(20, 1), 20);
    assert.equal(backoffMs(20, 2), 40);
    assert.deepEqual(TRANSIENT_STATUSES, [0, 408, 429, 500, 502, 503, 504]);
  });
});

describe("controlled_retry in executeAttempt", () => {
  it("recovers a transient read and lets the verifier pass on the successful attempt", async () => {
    const slept: number[] = [];
    const client = sequenceClient([
      { status: 503, body: { error: "timeout", message: "blip" } },
      { status: 200, body: { order_id: "ord_0001", status: "placed" } },
    ]);
    const failed = await executeAttempt({
      prompt: "Read the order.",
      taskId: "T4",
      actions: [{ tool_name: "get_order", tool_input: { order_id: "ord_0001" } }],
      client: sequenceClient([{ status: 503, body: { error: "timeout", message: "blip" } }]),
      sessionId: "sess-a",
      permissions: ["read"],
      plan: null,
      timeoutMs: 30_000,
      startedMs: Date.now(),
      sleep: async () => {},
    });
    assert.equal(failed.claimedSuccess, false);
    assert.equal(failed.reportedOrderStatus, undefined);

    const recovered = await executeAttempt({
      prompt: "Read the order.",
      taskId: "T4",
      actions: [{ tool_name: "get_order", tool_input: { order_id: "ord_0001" } }],
      client,
      sessionId: "sess-a",
      permissions: ["read"],
      plan: null,
      timeoutMs: 30_000,
      startedMs: Date.now(),
      fixKinds: ["controlled_retry"],
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    assert.equal(client.calls, 2);
    assert.deepEqual(slept, [20]);
    assert.equal(recovered.reportedOrderStatus, "placed");
    assert.equal(recovered.claimedSuccess, true);
    const task = reference.tasks.find((entry) => entry.task_id === "T4");
    assert.ok(task);
    const snapshot = {
      carts: [],
      orders: [
        {
          order_id: "ord_0001",
          session_id: "sess-a",
          status: "placed",
          items: [],
          total_usd: 24,
        },
      ],
      inventory: [],
      observations: [
        {
          session_id: "sess-a",
          catalog_reads: [],
          product_views: [],
          order_reads: [{ order_id: "ord_0001" }],
        },
      ],
    };
    const missed = verifyOutcome({
      checks: task.success_test.checks,
      snapshot,
      sessionId: "sess-a",
      permissions: ["read"],
      orderId: "ord_0001",
      reportedOrderStatus: failed.reportedOrderStatus,
      agentClaimedSuccess: failed.claimedSuccess,
    });
    const passed = verifyOutcome({
      checks: task.success_test.checks,
      snapshot,
      sessionId: "sess-a",
      permissions: ["read"],
      orderId: "ord_0001",
      reportedOrderStatus: recovered.reportedOrderStatus,
      agentClaimedSuccess: recovered.claimedSuccess,
    });
    assert.equal(missed.verifier.passed, false);
    assert.equal(passed.verifier.passed, true);
  });

  it("stops after two retries on a read that stays transient", async () => {
    const slept: number[] = [];
    const client = sequenceClient([{ status: 504, body: { error: "timeout" } }]);
    const execution = await executeAttempt({
      prompt: "Search.",
      taskId: "T1",
      actions: [{ tool_name: "search_products", tool_input: { q: "mug" } }],
      client,
      sessionId: "sess-a",
      permissions: ["read"],
      plan: null,
      timeoutMs: 30_000,
      startedMs: Date.now(),
      fixKinds: ["controlled_retry"],
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    assert.equal(client.calls, 3);
    assert.deepEqual(slept, [20, 40]);
    assert.equal(execution.steps.filter((step) => step.type === "tool_result").length, 3);
    assert.equal(execution.claimedSuccess, false);
  });

  it("does not retry a dispatched mutate 5xx and does retry one that never left the process", async () => {
    const dispatched = sequenceClient([{ status: 500, body: { error: "error" } }]);
    const once = await executeAttempt({
      prompt: "Check out.",
      taskId: "T3",
      actions: [{ tool_name: "checkout", tool_input: {} }],
      client: dispatched,
      sessionId: "sess-a",
      permissions: ["read", "write:order"],
      plan: null,
      timeoutMs: 30_000,
      startedMs: Date.now(),
      fixKinds: ["controlled_retry"],
      sleep: async () => {},
    });
    assert.equal(dispatched.calls, 1);
    assert.equal(once.steps.filter((step) => step.tool_name === "checkout" && step.type === "tool_result").length, 1);

    let throws = 0;
    const flaky: MockShopClient & { calls: number } = {
      calls: 0,
      async reset() {
        return emptyState();
      },
      async state() {
        return emptyState();
      },
      async request() {
        this.calls += 1;
        if (this.calls === 1) {
          throws += 1;
          throw new TypeError("connect refused");
        }
        return { status: 200, body: { order_id: "ord_0001", status: "placed" } };
      },
    };
    const retried = await executeAttempt({
      prompt: "Check out.",
      taskId: "T3",
      actions: [{ tool_name: "checkout", tool_input: {} }],
      client: flaky,
      sessionId: "sess-a",
      permissions: ["read", "write:order"],
      plan: null,
      timeoutMs: 30_000,
      startedMs: Date.now(),
      fixKinds: ["controlled_retry"],
      sleep: async () => {},
    });
    assert.equal(throws, 1);
    assert.equal(flaky.calls, 2);
    assert.equal(retried.claimedSuccess, true);

    const bare: MockShopClient = {
      async reset() {
        return emptyState();
      },
      async state() {
        return emptyState();
      },
      async request() {
        throw new TypeError("connect refused");
      },
    };
    await assert.rejects(
      () =>
        executeAttempt({
          prompt: "Check out.",
          taskId: "T3",
          actions: [{ tool_name: "checkout", tool_input: {} }],
          client: bare,
          sessionId: "sess-a",
          permissions: ["read", "write:order"],
          plan: null,
          timeoutMs: 30_000,
          startedMs: Date.now(),
        }),
      /connect refused/,
    );
  });

  it("re-drops checkout on every attempt and keeps a single fault label", async () => {
    const client = sequenceClient([{ status: 200, body: { items: [], total_usd: 0 } }]);
    const plan: InjectionPlan = {
      fault: "Drop the checkout call and return a timeout instead of executing it.",
      target: "checkout",
      ground_truth: { category: "Execution", code: "dropped_tool_call" },
    };
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
      fixKinds: ["controlled_retry"],
      sleep: async () => {},
    });
    const checkoutResults = execution.steps.filter(
      (step) => step.type === "tool_result" && step.tool_name === "checkout",
    );
    assert.equal(checkoutResults.length, 3);
    assert.equal(client.calls, 1);
    for (const step of checkoutResults) {
      assert.deepEqual(step.tool_output, droppedOutput());
    }
    assert.equal(execution.labels.length, 1);
    assert.equal(execution.labels[0]?.code, "dropped_tool_call");
    assert.equal(execution.labels[0]?.category, "Execution");
    assert.equal(execution.claimedSuccess, false);
    const labeled = execution.steps.find((step) => step.step_id === execution.labels[0]?.step_id);
    assert.equal(labeled?.type, "tool_result");
    assert.equal(labeled?.tool_name, "checkout");
  });

  it("does not retry a status outside the transient set", async () => {
    const client = sequenceClient([{ status: 501, body: { error: "error" } }]);
    await executeAttempt({
      prompt: "Search.",
      taskId: "T1",
      actions: [{ tool_name: "get_product", tool_input: { product_id: "SKU-MUG-01" } }],
      client,
      sessionId: "sess-a",
      permissions: ["read"],
      plan: null,
      timeoutMs: 30_000,
      startedMs: Date.now(),
      fixKinds: ["controlled_retry"],
      sleep: async () => {
        throw new Error("backoff should not run");
      },
    });
    assert.equal(client.calls, 1);
  });
});
