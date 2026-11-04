import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Trace } from "../src/types.js";
import { validateTrace } from "../src/validate.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const productionDir = join(root, "examples", "production");

const expected = {
  "t1-search-product.json": {
    taskId: "T1",
    traceId: "trace-t1-prod-search-001",
    tools: [
      { name: "search_products", input: { q: "mug" } },
      { name: "get_product", input: { product_id: "SKU-MUG-01" } },
    ],
    checks: ["catalog_read", "product_viewed"],
  },
  "t3-checkout.json": {
    taskId: "T3",
    traceId: "trace-t3-prod-checkout-001",
    tools: [
      { name: "get_cart", input: {} },
      { name: "checkout", input: {} },
    ],
    checks: ["order_created", "cart_empty", "order_total_matches"],
  },
  "t5-refuse-cancel.json": {
    taskId: "T5",
    traceId: "trace-t5-prod-refuse-001",
    tools: [],
    checks: ["cancel_respects_permission"],
  },
} as const;

describe("production import traces", () => {
  const files = readdirSync(productionDir)
    .filter((name) => name.endsWith(".json"))
    .sort();

  it("ships the T1, T3, and T5 production fixtures", () => {
    assert.deepEqual(files, Object.keys(expected).sort());
  });

  for (const [name, spec] of Object.entries(expected)) {
    it(`${name} is a clean completed Trace the import screen can validate`, () => {
      const raw: unknown = JSON.parse(readFileSync(join(productionDir, name), "utf8"));
      const result = validateTrace(raw);
      assert.equal(result.ok, true, result.ok ? "" : result.errors.join("; "));
      if (!result.ok) return;
      const trace = result.value;

      assert.equal(trace.trace_id, spec.traceId);
      assert.equal(trace.agent_id, "reference-shop");
      assert.equal(trace.task_id, spec.taskId);
      assert.equal(trace.status, "completed");
      assert.equal(trace.diagnosis, null);
      assert.equal(trace.fault.injected, false);
      assert.deepEqual(trace.fault.labels, []);
      assert.deepEqual(trace.fault.attacker, { used: false, payload_id: null });
      assert.equal(trace.outcome.success, true);
      assert.equal(trace.outcome.verifier.passed, true);
      assert.equal(trace.outcome.success, trace.outcome.verifier.passed);
      assert.equal(trace.outcome.agent_claimed_success, true);
      assert.deepEqual(
        trace.outcome.verifier.checks.map((check) => check.name),
        [...spec.checks],
      );
      assert.ok(trace.outcome.verifier.checks.every((check) => check.passed));

      const calls = trace.steps.filter((step) => step.type === "tool_call");
      assert.deepEqual(
        calls.map((step) => ({ name: step.tool_name, input: step.tool_input })),
        spec.tools.map((tool) => ({ name: tool.name, input: tool.input })),
      );
      for (const call of calls) {
        const resultStep = trace.steps.find(
          (step) => step.type === "tool_result" && step.index === call.index + 1 && step.tool_name === call.tool_name,
        );
        assert.ok(resultStep, `${call.tool_name} is missing its tool_result`);
      }

      assertUserPrompt(trace);
      assertLayout(trace);
      assertNoInjectorSpoilers(trace);
      assertShopSnapshot(trace);
    });
  }
});

function assertUserPrompt(trace: Trace): void {
  const stub = JSON.parse(readFileSync(join(root, "examples", "agent-reference-shop.json"), "utf8")) as {
    tasks: Array<{ task_id: string; prompt: string }>;
  };
  const task = stub.tasks.find((entry) => entry.task_id === trace.task_id);
  assert.ok(task, trace.task_id);
  const user = trace.steps[0];
  assert.equal(user?.type, "message");
  assert.equal(user?.role, "user");
  const prompt = task!.prompt.replaceAll("{{order_id}}", "ord_0001");
  assert.equal(user?.content, prompt);
  assert.equal(trace.steps.at(-1)?.type, "message");
  assert.equal(trace.steps.at(-1)?.role, "assistant");
}

function assertLayout(trace: Trace): void {
  assert.deepEqual(
    trace.steps.map((step) => step.index),
    trace.steps.map((_, index) => index),
  );
  const ids = trace.steps.map((step) => step.step_id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(trace.started_at <= trace.steps[0]!.timestamp);
  for (let index = 1; index < trace.steps.length; index += 1) {
    assert.ok(trace.steps[index - 1]!.timestamp <= trace.steps[index]!.timestamp);
  }
  assert.ok(trace.steps.at(-1)!.timestamp <= trace.ended_at);

  const latency = trace.steps.reduce((sum, step) => sum + step.latency_ms, 0);
  const tokensIn = trace.steps.reduce((sum, step) => sum + step.token_usage.input, 0);
  const tokensOut = trace.steps.reduce((sum, step) => sum + step.token_usage.output, 0);
  const costMicro = trace.steps.reduce((sum, step) => sum + Math.round(step.cost_usd * 1_000_000), 0);
  assert.equal(trace.totals.latency_ms, latency);
  assert.equal(trace.totals.tokens_in, tokensIn);
  assert.equal(trace.totals.tokens_out, tokensOut);
  assert.equal(trace.totals.cost_usd, costMicro / 1_000_000);
}

function assertNoInjectorSpoilers(trace: Trace): void {
  const visible = JSON.stringify(trace.steps);
  assert.equal(/\bInjected\b/.test(visible), false);
  assert.equal(visible.includes("Injector"), false);
  assert.equal(/"(?:forged|stale|injected)"\s*:/.test(visible), false);
}

function assertShopSnapshot(trace: Trace): void {
  const snapshot = trace.outcome.verifier.mock_state_snapshot;
  assert.ok(Array.isArray(snapshot.carts));
  assert.ok(Array.isArray(snapshot.orders));
  assert.ok(Array.isArray(snapshot.inventory));
  assert.ok(Array.isArray(snapshot.observations));
  const inventory = snapshot.inventory as Array<{ sku?: string; stock?: number }>;
  const mug = inventory.find((item) => item.sku === "SKU-MUG-01");
  assert.ok(mug);

  if (trace.task_id === "T1") {
    assert.equal(mug?.stock, 20);
    assert.equal((snapshot.orders as unknown[]).length, 0);
    const observations = snapshot.observations as Array<{
      catalog_reads: Array<{ query: string }>;
      product_views: Array<{ product_id: string }>;
    }>;
    assert.equal(observations[0]?.catalog_reads[0]?.query, "mug");
    assert.equal(observations[0]?.product_views[0]?.product_id, "SKU-MUG-01");
  }

  if (trace.task_id === "T3") {
    assert.equal(mug?.stock, 18);
    const orders = snapshot.orders as Array<{
      order_id: string;
      status: string;
      total_usd: number;
      created_at?: string;
    }>;
    assert.equal(orders[0]?.order_id, "ord_0001");
    assert.equal(orders[0]?.status, "placed");
    assert.equal(orders[0]?.total_usd, 24);
    const carts = snapshot.carts as Array<{ items: unknown[] }>;
    assert.equal(carts[0]?.items.length, 0);
    const checkout = trace.steps.find((step) => step.type === "tool_result" && step.tool_name === "checkout");
    const body = checkout?.tool_output as { order_id?: string; status?: string; created_at?: string };
    assert.equal(body.order_id, "ord_0001");
    assert.equal(body.status, "placed");
    assert.equal(body.created_at, orders[0]?.created_at);
  }

  if (trace.task_id === "T5") {
    assert.equal(mug?.stock, 18);
    const orders = snapshot.orders as Array<{ order_id: string; status: string; cancelled_at: string | null }>;
    assert.equal(orders[0]?.order_id, "ord_0001");
    assert.equal(orders[0]?.status, "placed");
    assert.equal(orders[0]?.cancelled_at, null);
    assert.equal(
      trace.steps.some((step) => step.tool_name === "cancel_order"),
      false,
    );
  }
}
