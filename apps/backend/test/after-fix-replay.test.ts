import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { Agent, Run, Trace } from "@mesa/shared";
import { validateRun, validateTrace } from "@mesa/shared/validate";
import { REFERENCE_AGENT_ID } from "../src/agents/store.js";
import { buildApp } from "../src/app.js";
import { resolveAfterFixParent } from "../src/harness/replay.js";
import {
  DEMO_STORYBOARD_RUN_ID,
  DEMO_STORYBOARD_TRACE_ID,
  seedDemoRunsAndTraces,
} from "../src/persistence/demo-seed.js";
import { MemoryStore } from "../src/persistence/memory.js";
import { startMockShop } from "./helpers.js";

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

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
    if (!baseline.ok) assert.match(baseline.message, /injected or after_fix/);

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

  it("injects from a baseline parent_run_id and rejects a non-baseline parent", async () => {
    const store = new MemoryStore();
    const app = buildApp({ logger: false, mockBaseUrl: baseUrl, store });
    try {
      const baseline = await app.inject({
        method: "POST",
        url: "/runs",
        payload: { agent_id: "reference-shop", phase: "baseline", task_ids: ["T3"] },
      });
      assert.equal(baseline.statusCode, 200, baseline.body);
      const parentId = baseline.json().results[0].run.run_id as string;

      const injected = await app.inject({
        method: "POST",
        url: "/runs",
        payload: {
          agent_id: "reference-shop",
          phase: "injected",
          parent_run_id: parentId,
        },
      });
      assert.equal(injected.statusCode, 200, injected.body);
      const child = injected.json().results[0] as { run: Run; parent: { run: Run } };
      assert.equal(child.run.phase, "injected");
      assert.equal(child.run.task_id, "T3");
      assert.equal(child.run.parent_run_id, parentId);
      assert.equal(child.parent.run.run_id, parentId);
      assert.ok(child.run.injection_plan);

      const fromInjected = await app.inject({
        method: "POST",
        url: "/runs",
        payload: {
          agent_id: "reference-shop",
          phase: "injected",
          parent_run_id: child.run.run_id,
        },
      });
      assert.equal(fromInjected.statusCode, 400);
      assert.match(fromInjected.json().message, /baseline/);
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
      assert.match(wrongPhase.json().message, /injected or after_fix/);

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

  it("replays the seeded T3 forged checkout on the test instance to a passing verifier", async () => {
    const store = new MemoryStore();
    await seedDemoRunsAndTraces(store);
    const seen: Array<{ url: string; fix_kinds?: unknown }> = [];
    const runtime = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (request.method === "GET" && request.url === "/health") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ status: "ok" }));
          return;
        }
        if (request.method === "POST" && request.url === "/v1/tasks/run") {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            fix_kinds?: unknown;
          };
          seen.push({ url: request.url, fix_kinds: body.fix_kinds });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              executed: false,
              actions: [
                { tool_name: "get_cart", tool_input: {} },
                { tool_name: "checkout", tool_input: {} },
                { tool_name: "get_cart", tool_input: {} },
                { tool_name: "checkout", tool_input: {} },
              ],
            }),
          );
          return;
        }
        response.writeHead(404);
        response.end();
      });
    });
    const runtimeUrl = await listen(runtime);
    const app = buildApp({ logger: false, mockBaseUrl: baseUrl, store });
    try {
      const current = await app.inject({ method: "GET", url: `/agents/${REFERENCE_AGENT_ID}` });
      const agent = current.json() as Agent;
      const saved = await app.inject({
        method: "PUT",
        url: `/agents/${REFERENCE_AGENT_ID}`,
        payload: {
          ...agent,
          instance: { ...agent.instance, base_url: runtimeUrl },
          test_instance: { ...agent.test_instance, base_url: runtimeUrl },
        },
      });
      assert.equal(saved.statusCode, 200, saved.body);

      const replay = await app.inject({
        method: "POST",
        url: "/runs",
        payload: {
          agent_id: REFERENCE_AGENT_ID,
          phase: "after_fix",
          parent_run_id: DEMO_STORYBOARD_RUN_ID,
          fix_kinds: ["pre_response_check"],
        },
      });
      assert.equal(replay.statusCode, 200, replay.body);
      const afterFix = replay.json().results[0] as {
        driver: string;
        run: Run;
        trace: Trace;
        parent: { run: Run; trace: Trace };
      };
      assert.equal(afterFix.driver, "http");
      assert.deepEqual(seen[0]?.fix_kinds, ["pre_response_check"]);
      assert.equal(afterFix.run.parent_run_id, DEMO_STORYBOARD_RUN_ID);
      assert.equal(afterFix.parent.trace.trace_id, DEMO_STORYBOARD_TRACE_ID);
      assert.equal(afterFix.parent.trace.outcome.verifier.passed, false);
      assert.equal(
        afterFix.parent.trace.outcome.verifier.checks.some((check) => check.name === "order_created" && !check.passed),
        true,
      );
      assert.equal(afterFix.trace.outcome.verifier.passed, true);
      assert.equal(afterFix.trace.outcome.verifier.checks.find((check) => check.name === "order_created")?.passed, true);
      assert.equal(afterFix.trace.fault.injected, true);
      assert.equal(afterFix.trace.fault.labels[0]?.code, "forged_tool_result");
      assert.equal(afterFix.run.injection_plan?.ground_truth.code, "forged_tool_result");
    } finally {
      await app.close();
      await closeServer(runtime);
    }
  });
});
