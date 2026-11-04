import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { FAULT_CATEGORIES, GROK_FORBIDDEN_WRITE_PATHS } from "@mesa/shared";
import { buildApp } from "../src/app.js";
import { MemoryStore } from "../src/persistence/memory.js";
import { startMockShop } from "./helpers.js";

describe("harness HTTP API", { concurrency: false }, () => {
  let baseUrl = "";
  let closeShop: () => Promise<void> = async () => {};

  before(async () => {
    const shop = await startMockShop();
    baseUrl = shop.baseUrl;
    closeShop = shop.close;
  });

  after(async () => {
    await closeShop();
  });

  it("reports health, the fault catalog, and refuses a baseline injection", async () => {
    const app = buildApp({ logger: false, mockBaseUrl: baseUrl, store: new MemoryStore() });
    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      assert.equal(health.statusCode, 200);
      assert.equal(health.json().role, "harness");
      assert.deepEqual(health.json().grok_forbidden_write_paths, [...GROK_FORBIDDEN_WRITE_PATHS]);

      const faults = await app.inject({ method: "GET", url: "/faults" });
      assert.equal(faults.statusCode, 200);
      assert.deepEqual(
        faults.json().faults.map((entry: { category: string }) => entry.category),
        [...FAULT_CATEGORIES],
      );

      const rejected = await app.inject({
        method: "POST",
        url: "/runs",
        payload: {
          phase: "baseline",
          task_ids: ["T1"],
          injection: {
            fault: "Replace the checkout tool result with a successful order that the mock did not create.",
            target: "checkout",
            ground_truth: { category: "ToolUse", code: "forged_tool_result" },
          },
        },
      });
      assert.equal(rejected.statusCode, 400);

      const missing = await app.inject({ method: "GET", url: "/runs/does-not-exist" });
      assert.equal(missing.statusCode, 404);
    } finally {
      await app.close();
    }
  });

  it("persists a baseline pass and an injected failure", async () => {
    const store = new MemoryStore();
    const app = buildApp({ logger: false, mockBaseUrl: baseUrl, store });
    try {
      const baseline = await app.inject({
        method: "POST",
        url: "/runs",
        payload: { phase: "baseline", task_ids: ["T2"] },
      });
      assert.equal(baseline.statusCode, 200);
      const passed = baseline.json().results[0];
      assert.equal(passed.run.status, "passed");
      assert.equal(passed.trace.diagnosis, null);
      assert.equal(passed.trace.outcome.verifier.passed, true);
      assert.equal(passed.trace.outcome.success, true);
      assert.equal(passed.run.injection_plan, null);

      const injected = await app.inject({
        method: "POST",
        url: "/runs",
        payload: { phase: "injected", task_ids: ["T3"] },
      });
      assert.equal(injected.statusCode, 200);
      const failed = injected.json().results[0];
      assert.equal(failed.run.phase, "injected");
      assert.equal(failed.run.status, "failed");
      assert.equal(failed.run.injection_plan.ground_truth.code, "forged_tool_result");
      assert.equal(failed.trace.fault.labels[0].code, "forged_tool_result");
      assert.equal(failed.trace.fault.labels[0].category, "ToolUse");
      assert.equal(failed.trace.outcome.verifier.passed, false);
      assert.equal(failed.trace.outcome.agent_claimed_success, true);
      assert.equal(failed.trace.diagnosis, null);
      assert.equal(Object.hasOwn(failed.trace, "injection_plan"), false);
      assert.equal(Object.hasOwn(failed.trace, "phase"), false);

      const storedRun = await app.inject({ method: "GET", url: `/runs/${passed.run.run_id}` });
      assert.equal(storedRun.statusCode, 200);
      assert.equal(storedRun.json().trace_ids[0], passed.trace.trace_id);

      const storedTrace = await app.inject({ method: "GET", url: `/traces/${failed.trace.trace_id}` });
      assert.equal(storedTrace.statusCode, 200);
      assert.equal(storedTrace.json().outcome.verifier.passed, false);
      assert.equal(storedTrace.json().diagnosis, null);
      assert.equal(store.getTrace(failed.trace.trace_id)?.fault.labels[0]?.code, "forged_tool_result");
    } finally {
      await app.close();
    }
  });
});
