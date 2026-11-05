import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Run, Trace } from "@mesa/shared";
import { validateRun, validateTrace } from "@mesa/shared/validate";
import { buildApp } from "../src/app.js";
import { resolveAfterFixParent } from "../src/harness/replay.js";
import { MemoryStore } from "../src/persistence/memory.js";
import { startMockShop } from "./helpers.js";

describe("resolveAfterFixParent", () => {
  it("leaves a run without parent_run_id unchanged", async () => {
    const store = new MemoryStore();
    const result = await resolveAfterFixParent({
      store,
      agentId: "reference-shop",
      phase: "after_fix",
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value, null);
  });

  it("rejects parent_run_id on baseline, a missing parent, and an agent mismatch", async () => {
    const store = new MemoryStore();
    const baseline = await resolveAfterFixParent({
      store,
      agentId: "reference-shop",
      phase: "baseline",
      parentRunId: "run-missing",
    });
    assert.equal(baseline.ok, false);
    if (!baseline.ok) assert.match(baseline.message, /after_fix/);

    const missing = await resolveAfterFixParent({
      store,
      agentId: "reference-shop",
      phase: "after_fix",
      parentRunId: "run-missing",
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.message, /No run run-missing/);

    const parent: Run = {
      run_id: "run-other-agent",
      agent_id: "other-agent",
      task_id: "T1",
      phase: "injected",
      status: "failed",
      trace_ids: [],
      injection_plan: {
        fault: "Skip search.",
        target: "search_products",
        ground_truth: { category: "Verification", code: "suppressed_readback" },
      },
      fix_kinds: [],
    };
    assert.equal(validateRun(parent).ok, true);
    await store.saveRun(parent);
    const mismatch = await resolveAfterFixParent({
      store,
      agentId: "reference-shop",
      phase: "after_fix",
      parentRunId: parent.run_id,
    });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.match(mismatch.message, /other-agent/);
  });
});

describe("POST /runs after_fix replay from a parent", { concurrency: false }, () => {
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

  it("inherits the parent injection plan, stores parent_run_id, and returns before/after links", async () => {
    const store = new MemoryStore();
    const app = buildApp({ logger: false, mockBaseUrl: baseUrl, store });
    try {
      const injected = await app.inject({
        method: "POST",
        url: "/runs",
        payload: { agent_id: "reference-shop", phase: "injected", task_ids: ["T1"] },
      });
      assert.equal(injected.statusCode, 200, injected.body);
      const before = injected.json().results[0] as {
        run: Run;
        trace: Trace;
        links: { run: string; parent_run: string | null };
      };
      assert.equal(before.run.phase, "injected");
      assert.equal(before.trace.outcome.verifier.passed, false);
      assert.equal(before.links.run, `/runs/${before.run.run_id}`);
      assert.equal(before.links.parent_run, null);

      const replay = await app.inject({
        method: "POST",
        url: "/runs",
        payload: {
          agent_id: "reference-shop",
          phase: "after_fix",
          parent_run_id: before.run.run_id,
          fix_kinds: ["pre_response_check"],
        },
      });
      assert.equal(replay.statusCode, 200, replay.body);
      const afterFix = replay.json().results[0] as {
        run: Run;
        trace: Trace;
        parent: { run: Run; trace: Trace };
        links: {
          run: string;
          trace: string;
          parent_run: string;
          parent_trace: string;
        };
      };
      assert.equal(afterFix.run.phase, "after_fix");
      assert.equal(afterFix.run.task_id, "T1");
      assert.equal(afterFix.run.parent_run_id, before.run.run_id);
      assert.deepEqual(afterFix.run.fix_kinds, ["pre_response_check"]);
      assert.equal(afterFix.run.injection_plan?.ground_truth.code, before.run.injection_plan?.ground_truth.code);
      assert.equal(afterFix.parent.run.run_id, before.run.run_id);
      assert.deepEqual(afterFix.parent.trace.outcome.verifier, before.trace.outcome.verifier);
      assert.equal(afterFix.links.run, `/runs/${afterFix.run.run_id}`);
      assert.equal(afterFix.links.trace, `/traces/${afterFix.trace.trace_id}`);
      assert.equal(afterFix.links.parent_run, `/runs/${before.run.run_id}`);
      assert.equal(afterFix.links.parent_trace, `/traces/${before.trace.trace_id}`);
      assert.equal(afterFix.trace.outcome.success, afterFix.trace.outcome.verifier.passed);
      assert.equal(validateRun(afterFix.run).ok, true);
      assert.equal(validateTrace(afterFix.trace).ok, true);

      const listed = await app.inject({ method: "GET", url: "/runs" });
      assert.equal(listed.statusCode, 200);
      const snapshot = listed.json();
      const childLink = snapshot.trace_links.find((link: { run_id: string }) => link.run_id === afterFix.run.run_id);
      const parentLink = snapshot.trace_links.find((link: { run_id: string }) => link.run_id === before.run.run_id);
      assert.equal(childLink.parent_run_id, before.run.run_id);
      assert.deepEqual(parentLink.child_run_ids, [afterFix.run.run_id]);
      assert.equal(childLink.traces[0].outcome.verifier.passed, afterFix.trace.outcome.verifier.passed);
      assert.equal(parentLink.traces[0].totals.cost_usd, before.trace.totals.cost_usd);
    } finally {
      await app.close();
    }
  });

  it("keeps injection null when the caller sends null, and rejects a bad parent", async () => {
    const store = new MemoryStore();
    const app = buildApp({ logger: false, mockBaseUrl: baseUrl, store });
    try {
      const injected = await app.inject({
        method: "POST",
        url: "/runs",
        payload: { agent_id: "reference-shop", phase: "injected", task_ids: ["T3"] },
      });
      assert.equal(injected.statusCode, 200, injected.body);
      const parentId = injected.json().results[0].run.run_id as string;

      const clean = await app.inject({
        method: "POST",
        url: "/runs",
        payload: {
          agent_id: "reference-shop",
          phase: "after_fix",
          parent_run_id: parentId,
          injection: null,
          fix_kinds: ["pre_response_check"],
        },
      });
      assert.equal(clean.statusCode, 200, clean.body);
      const result = clean.json().results[0];
      assert.equal(result.run.injection_plan, null);
      assert.equal(result.run.parent_run_id, parentId);
      assert.equal(result.trace.fault.injected, false);

      const missing = await app.inject({
        method: "POST",
        url: "/runs",
        payload: {
          agent_id: "reference-shop",
          phase: "after_fix",
          parent_run_id: "run-missing",
          fix_kinds: ["permission_guard"],
        },
      });
      assert.equal(missing.statusCode, 400);
      assert.match(missing.json().message, /No run run-missing/);

      const wrongPhase = await app.inject({
        method: "POST",
        url: "/runs",
        payload: {
          agent_id: "reference-shop",
          phase: "baseline",
          parent_run_id: parentId,
        },
      });
      assert.equal(wrongPhase.statusCode, 400);
      assert.match(wrongPhase.json().message, /after_fix/);

      const wrongTask = await app.inject({
        method: "POST",
        url: "/runs",
        payload: {
          agent_id: "reference-shop",
          phase: "after_fix",
          parent_run_id: parentId,
          task_ids: ["T1"],
          fix_kinds: ["pre_response_check"],
        },
      });
      assert.equal(wrongTask.statusCode, 400);
      assert.match(wrongTask.json().message, /T3/);
    } finally {
      await app.close();
    }
  });
});
