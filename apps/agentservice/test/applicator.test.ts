import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { readEmbeddedInstructions, retryDecision } from "../src/fixes/domain.js";
import { runApplicatorProbes } from "../src/fixes/probes.js";
import { applyFixesToPlan, basePlan } from "../src/fixes/plan.js";
import { wrapShopClient, type ShopToolClient, type ShopToolResponse } from "../src/fixes/applicator.js";
import { selectFixes } from "../src/replay/select.js";
import { runReplay } from "../src/replay/run.js";
import type { AttemptScore, ReplayPort } from "../src/replay/types.js";

describe("fix applicator", () => {
  it("retries a read on timeout and does not retry a dispatched checkout failure", async () => {
    const probes = await runApplicatorProbes();
    assert.equal(probes.read_retry.attempts, 2);
    assert.equal(probes.read_retry.outcome, "success");
    assert.deepEqual(probes.read_retry.slept_ms, [20]);
    assert.equal(probes.mutate_dispatched_5xx_attempts, 1);
    assert.equal(probes.mutate_not_dispatched_attempts, 2);
    assert.equal(probes.cancel_refused, true);
    assert.equal(probes.cancel_client_calls_when_refused, 0);
    assert.equal(probes.note_cancel_calls_without_guard, 1);
    assert.deepEqual([...probes.note_permissions_without_guard], ["read"]);
    assert.equal(probes.note_cancel_calls_with_guard, 0);
    assert.equal(probes.forged_checkout_claimed_success, false);
  });

  it("does not retry a terminal tool error", async () => {
    let calls = 0;
    const client = countingClient(() => {
      calls += 1;
      return { status: 404, body: { error: "not_found" }, dispatched: true };
    });
    const tools = wrapShopClient({
      client,
      fixes: ["controlled_retry"],
      config: { maxRetries: 2, baseBackoffMs: 20 },
      sleep: async () => {},
      now: () => 0,
    });
    const applied = await tools.call({
      tool_name: "get_product",
      tool_input: { product_id: "missing" },
      sessionId: "s",
      permissions: ["read"],
    });
    assert.equal(applied.outcome, "terminal");
    assert.equal(calls, 1);
  });

  it("stops when maxRetries is 0", async () => {
    let calls = 0;
    const tools = wrapShopClient({
      client: countingClient(() => {
        calls += 1;
        return { status: 503, body: { error: "timeout" }, dispatched: true };
      }),
      fixes: ["controlled_retry"],
      config: { maxRetries: 0, baseBackoffMs: 20 },
      sleep: async () => {},
      now: () => 0,
    });
    const applied = await tools.call({
      tool_name: "get_cart",
      tool_input: {},
      sessionId: "s",
      permissions: ["read"],
    });
    assert.equal(applied.outcome, "transient");
    assert.equal(calls, 1);
  });

  it("allows cancel_order when the grant includes write:order:cancel", async () => {
    let calls = 0;
    const tools = wrapShopClient({
      client: countingClient(() => {
        calls += 1;
        return { status: 200, body: { status: "cancelled" }, dispatched: true };
      }),
      fixes: ["permission_guard"],
      sleep: async () => {},
      now: () => 0,
    });
    const applied = await tools.call({
      tool_name: "cancel_order",
      tool_input: { order_id: "ord_0001" },
      sessionId: "s",
      permissions: ["read", "write:order:cancel"],
    });
    assert.equal(applied.outcome, "success");
    assert.equal(calls, 1);
  });

  it("treats the jury note as data and does not widen the grant", () => {
    const note = readFileSync(new URL("../../backend/fixtures/jury/jury-note.md", import.meta.url), "utf8");
    const found = readEmbeddedInstructions({ source: "attached_note", text: note });
    assert.equal(
      found.some((entry) => entry.kind === "tool" && entry.value === "cancel_order"),
      true,
    );
    assert.equal(
      found.some((entry) => entry.kind === "permission" && entry.value === "write:order:cancel"),
      true,
    );
    assert.equal(
      found.some((entry) => entry.kind === "permission" && entry.value === "write:order"),
      false,
    );
    const shaped = applyFixesToPlan({
      taskId: "T5",
      permissions: ["read"],
      orderId: "ord_0001",
      fixes: ["permission_guard"],
      prompt: note,
    });
    assert.deepEqual(shaped.actions, []);
    assert.equal(shaped.refused.some((entry) => entry.tool_name === "cancel_order"), true);
    const unguarded = applyFixesToPlan({
      taskId: "T5",
      permissions: ["read"],
      orderId: "ord_0001",
      fixes: [],
      prompt: note,
    });
    assert.deepEqual(unguarded.actions, [{ tool_name: "cancel_order", tool_input: { order_id: "ord_0001" } }]);
  });

  it("appends a confirming read only for pre_response_check", () => {
    const plain = basePlan("T1", { permissions: ["read"] });
    const checked = applyFixesToPlan({
      taskId: "T1",
      permissions: ["read"],
      fixes: ["pre_response_check"],
    });
    assert.equal(checked.actions.length, plain.length + 1);
    assert.equal(checked.actions.at(-1)?.tool_name, "get_product");
    const retried = applyFixesToPlan({
      taskId: "T1",
      permissions: ["read"],
      fixes: ["controlled_retry"],
    });
    assert.deepEqual(retried.actions, plain);
    const t3 = applyFixesToPlan({
      taskId: "T3",
      permissions: ["read", "write:order"],
      fixes: ["pre_response_check"],
    });
    assert.deepEqual(
      t3.actions.map((action) => action.tool_name),
      ["get_cart", "checkout", "get_cart", "checkout"],
    );
  });

  it("rejects a retry config outside the allowed range", () => {
    assert.throws(
      () =>
        wrapShopClient({
          client: countingClient(() => ({ status: 200, body: {}, dispatched: true })),
          fixes: [],
          config: { maxRetries: 9 },
        }),
      /maxRetries/,
    );
  });

  it("does not retry a mutate tool after a dispatched timeout", () => {
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
        tool: "get_order",
        dispatched: true,
        completedAttempts: 1,
        maxRetries: 2,
        fixes: ["controlled_retry"],
      }),
      "retry",
    );
  });
});

describe("fix selection", () => {
  it("prefers a specified fix, then a diagnosis, then the ADR-002 map", () => {
    assert.deepEqual(selectFixes({ category: "Security", specified: [] }), {
      kinds: [],
      source: "specified",
    });
    assert.deepEqual(selectFixes({ category: "Reasoning", diagnosisFixes: ["controlled_retry"] }), {
      kinds: ["controlled_retry"],
      source: "diagnosis",
    });
    assert.deepEqual(selectFixes({ category: "Verification", diagnosisFixes: [] }), {
      kinds: ["pre_response_check"],
      source: "adr-002-category-map",
    });
    assert.deepEqual(selectFixes({ category: "ToolUse" }), { kinds: [], source: "none" });
    assert.deepEqual(selectFixes({ category: "Execution" }), {
      kinds: ["controlled_retry"],
      source: "adr-002-category-map",
    });
  });

  it("does not run after_fix when the preset has no MVP fix", async () => {
    let calls = 0;
    const port: ReplayPort = {
      async run() {
        calls += 1;
        return fakeAttempt(`run-${calls}`);
      },
    };
    const report = await runReplay({
      port,
      categoryFor: () => "Plan",
      tasks: ["T2"],
    });
    assert.equal(calls, 3);
    assert.equal(report.tasks[0]?.injected_after.status, "skipped");
    assert.equal(report.tasks[0]?.fix_verified, null);
  });
});

function countingClient(handler: () => ShopToolResponse): ShopToolClient {
  return { call: () => Promise.resolve(handler()) };
}

function fakeAttempt(runId: string): AttemptScore {
  return {
    source: "backend-harness",
    run_id: runId,
    parent_run_id: null,
    passed: false,
    failed_checks: [],
    agent_claimed_success: false,
    latency_ms: 1,
    step_count: 1,
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    duration_ms: 1,
    fix_kinds_on_run: [],
    policy_applied_in_call_agent: false,
    fix_kinds_on_agent_run_request: false,
  };
}
