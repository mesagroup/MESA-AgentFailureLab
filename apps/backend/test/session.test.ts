import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Run, RunStatus, Trace } from "@mesa/shared";
import { validateRun, validateTrace } from "@mesa/shared/validate";
import { MemoryAgentStore } from "../src/agents/store.js";
import { buildApp } from "../src/app.js";
import { HARNESS_SESSION_SCOPE, sessionView } from "../src/harness/session.js";
import { MemoryStore } from "../src/persistence/memory.js";
import { loadReferenceAgent } from "../src/reference-agent.js";

function loadExampleTrace(): Trace {
  const raw: unknown = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../../packages/shared/examples/tool-error-trace.json", import.meta.url)),
      "utf8",
    ),
  );
  const result = validateTrace(raw);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.value;
}

function retarget(base: Trace, traceId: string, runId: string, passed: boolean): Trace {
  const next = structuredClone(base);
  next.trace_id = traceId;
  next.run_id = runId;
  next.outcome.success = passed;
  next.outcome.verifier.passed = passed;
  next.outcome.verifier.checks = [{ name: "order_created", passed, detail: traceId }];
  const result = validateTrace(next);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.value;
}

function baseline(runId: string, status: RunStatus, traceIds: string[]): Run {
  const run: Run = {
    run_id: runId,
    agent_id: "reference-shop",
    task_id: "T1",
    phase: "baseline",
    status,
    trace_ids: traceIds,
    injection_plan: null,
    fix_kinds: [],
  };
  const result = validateRun(run);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.value;
}

function injectedFailure(): Run {
  const run: Run = {
    run_id: "run-failed",
    agent_id: "reference-shop",
    task_id: "T3",
    phase: "injected",
    status: "failed",
    trace_ids: ["trace-fail", "trace-missing", "trace-other"],
    injection_plan: {
      fault: "Replace the checkout tool result with a successful order that the mock did not create.",
      target: "checkout",
      ground_truth: { category: "ToolUse", code: "forged_tool_result", step_id: "step-4" },
    },
    fix_kinds: [],
    error_message: "verifier failed",
  };
  const result = validateRun(run);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.value;
}

function collectKeys(value: unknown, keys: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      collectKeys(child, keys);
    }
  }
}

describe("harness session snapshot", () => {
  it("lists an empty harness with the seeded agent and zero run counts", async () => {
    const app = buildApp({ logger: false, store: new MemoryStore() });
    try {
      const listed = await app.inject({ method: "GET", url: "/runs" });
      assert.equal(listed.statusCode, 200);
      const body = listed.json();
      assert.deepEqual(body.runs, []);
      assert.deepEqual(body.trace_links, []);
      assert.deepEqual(body.counts, {
        scope: HARNESS_SESSION_SCOPE,
        agents: 2,
        runs: 0,
        queued: 0,
        running: 0,
        passed: 0,
        failed: 0,
        error: 0,
      });

      const agents = await app.inject({ method: "GET", url: "/agents" });
      assert.equal(agents.statusCode, 200);
      const rows = agents.json().agents as Array<{ agent_id: string; instance: { kind: string }; tasks: unknown[] }>;
      assert.deepEqual(
        rows.map((agent) => [agent.agent_id, agent.instance.kind, agent.tasks.length]),
        [
          ["reference-shop", "reference", 5],
          ["external-library", "external", 3],
        ],
      );
    } finally {
      await app.close();
    }
  });

  it("returns recent runs, verifier outcomes, and session counts", async () => {
    const store = new MemoryStore();
    const agents = new MemoryAgentStore();
    const example = loadExampleTrace();
    const passedTrace = retarget(example, "trace-pass", "run-passed", true);
    passedTrace.started_at = "2026-11-04T12:00:00.000Z";
    const failedTrace = retarget(example, "trace-fail", "run-failed", false);
    const otherTrace = retarget(example, "trace-other", "run-failed", true);
    const orphan = retarget(example, "trace-orphan", "run-nobody", false);
    await store.saveTrace(passedTrace);
    await store.saveTrace(failedTrace);
    await store.saveTrace(otherTrace);
    await store.saveTrace(orphan);

    const queued = baseline("run-queued", "queued", []);
    const running = baseline("run-running", "running", []);
    const passed = baseline("run-passed", "passed", ["trace-pass"]);
    const failed = injectedFailure();
    const errored = baseline("run-error", "error", []);
    errored.error_message = "Harness error";
    for (const run of [queued, running, passed, failed, errored]) await store.saveRun(run);

    const external = loadReferenceAgent();
    external.agent_id = "agent-ext-001";
    external.name = "External shop";
    external.created_at = "2026-11-04T10:00:00.000Z";
    external.updated_at = "2026-11-04T10:00:00.000Z";
    external.instance = { kind: "external", base_url: "http://127.0.0.1:3002", runtime: "grok" };
    await agents.create(external);

    const app = buildApp({ logger: false, store, agents });
    try {
      const listed = await app.inject({ method: "GET", url: "/runs" });
      assert.equal(listed.statusCode, 200);
      const body = listed.json();
      assert.deepEqual(
        body.runs.map((run: Run) => run.run_id),
        ["run-error", "run-failed", "run-passed", "run-running", "run-queued"],
      );
      for (const run of body.runs as Run[]) {
        const checked = validateRun(run);
        assert.equal(checked.ok, true, checked.ok ? "" : checked.errors.join("; "));
      }

      assert.equal(body.trace_links.length, body.runs.length);
      assert.deepEqual(
        body.trace_links.map((link: { run_id: string }) => link.run_id),
        body.runs.map((run: Run) => run.run_id),
      );

      const errorLink = body.trace_links[0];
      assert.equal(errorLink.first_trace_id, null);
      assert.deepEqual(errorLink.traces, []);
      assert.equal(errorLink.parent_run_id, null);
      assert.deepEqual(errorLink.child_run_ids, []);

      const failedLink = body.trace_links[1];
      assert.equal(failedLink.first_trace_id, "trace-fail");
      assert.deepEqual(
        failedLink.traces.map((trace: { trace_id: string }) => trace.trace_id),
        ["trace-fail", "trace-other"],
      );
      assert.deepEqual(failedLink.traces[0].outcome.verifier, failedTrace.outcome.verifier);
      assert.equal(failedLink.traces[0].outcome.verifier.passed, false);
      assert.equal(failedLink.traces[1].outcome.verifier.passed, true);
      assert.equal(failedLink.traces[0].totals.latency_ms, failedTrace.totals.latency_ms);
      assert.equal(failedLink.traces[0].started_at, failedTrace.started_at);

      const passedLink = body.trace_links[2];
      assert.equal(passedLink.first_trace_id, "trace-pass");
      assert.equal(passedLink.traces[0].outcome.verifier.passed, true);
      assert.deepEqual(passedLink.traces[0].outcome, passedTrace.outcome);

      assert.equal(body.trace_links[3].first_trace_id, null);
      assert.equal(body.trace_links[4].first_trace_id, null);
      assert.equal(JSON.stringify(body).includes("trace-orphan"), false);
      assert.equal(JSON.stringify(body).includes("trace-missing"), true);

      assert.deepEqual(body.counts, {
        scope: "harness_session",
        agents: 3,
        runs: 5,
        queued: 1,
        running: 1,
        passed: 1,
        failed: 1,
        error: 1,
      });

      const keys = new Set<string>();
      collectKeys(body, keys);
      assert.equal(keys.has("result"), false);
      assert.equal(keys.has("uptime"), false);
      assert.equal(keys.has("success_rate"), false);

      const one = await app.inject({ method: "GET", url: "/runs/run-passed" });
      assert.equal(one.statusCode, 200);
      assert.equal(one.json().run_id, "run-passed");
      assert.equal(Object.hasOwn(one.json(), "trace_links"), false);
      assert.equal(Object.hasOwn(one.json(), "counts"), false);
      assert.equal(Object.hasOwn(one.json(), "outcome"), false);

      const agentList = await app.inject({ method: "GET", url: "/agents" });
      const rows = agentList.json().agents as Array<{
        agent_id: string;
        instance: { kind: string };
        tasks: unknown[];
      }>;
      assert.deepEqual(
        rows.map((agent) => [agent.agent_id, agent.instance.kind, agent.tasks.length]),
        [
          ["reference-shop", "reference", 5],
          ["external-library", "external", 3],
          ["agent-ext-001", "external", 5],
        ],
      );
    } finally {
      await app.close();
    }
  });

  it("keeps trace link order aligned with the reversed run list", () => {
    const example = loadExampleTrace();
    const first = retarget(example, "trace-first", "run-first", true);
    const view = sessionView({
      runs: [baseline("run-first", "passed", ["trace-first"]), baseline("run-second", "queued", [])],
      traces: [first],
      agentCount: 1,
    });
    assert.equal(view.runs[0]?.run_id, "run-second");
    assert.equal(view.trace_links[0]?.first_trace_id, null);
    assert.equal(view.trace_links[1]?.first_trace_id, "trace-first");
    assert.equal(view.trace_links[0]?.parent_run_id, null);
    assert.deepEqual(view.trace_links[1]?.child_run_ids, []);
    assert.equal(view.counts.passed, 1);
    assert.equal(view.counts.queued, 1);
    assert.equal(view.counts.scope, HARNESS_SESSION_SCOPE);
  });

  it("pairs after_fix children with the parent run id", () => {
    const parent = injectedFailure();
    const child: Run = {
      run_id: "run-after",
      agent_id: parent.agent_id,
      task_id: parent.task_id,
      parent_run_id: parent.run_id,
      phase: "after_fix",
      status: "passed",
      trace_ids: [],
      injection_plan: parent.injection_plan,
      fix_kinds: ["pre_response_check"],
    };
    const checked = validateRun(child);
    assert.equal(checked.ok, true, checked.ok ? "" : checked.errors.join("; "));
    const view = sessionView({
      runs: [parent, child],
      traces: [],
      agentCount: 1,
    });
    assert.equal(view.runs[0]?.run_id, "run-after");
    assert.equal(view.trace_links[0]?.parent_run_id, "run-failed");
    assert.deepEqual(view.trace_links[0]?.child_run_ids, []);
    assert.deepEqual(view.trace_links[1]?.child_run_ids, ["run-after"]);
    assert.equal(view.trace_links[1]?.parent_run_id, null);
  });
});
