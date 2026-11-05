import assert from "node:assert/strict";
import test from "node:test";
import type { Run } from "@mesa/shared";
import type { RunTraceLink } from "./api.ts";
import * as dashboard from "./dashboard.ts";
import { dashboardRunHref, isShoppingDemo, linkFor, needsAttentionRuns } from "./dashboard.ts";

function run(partial: Partial<Run> & Pick<Run, "run_id" | "status" | "phase">): Run {
  return {
    agent_id: "agent-1",
    task_id: "task-1",
    parent_run_id: null,
    trace_ids: [],
    injection_plan: null,
    fix_kinds: [],
    ...partial,
  };
}

function link(partial: Partial<RunTraceLink> & Pick<RunTraceLink, "run_id">): RunTraceLink {
  return {
    first_trace_id: null,
    traces: [],
    parent_run_id: null,
    child_run_ids: [],
    ...partial,
  };
}

test("a run with a first trace opens that trace id", () => {
  const href = dashboardRunHref(
    { run_id: "run-1" },
    { first_trace_id: "trace-1" },
  );
  assert.equal(href, "/traces/trace-1");
  assert.equal(href.includes("run-1"), false);
});

test("a run with no trace opens the run", () => {
  assert.equal(
    dashboardRunHref({ run_id: "run-2" }, { first_trace_id: null }),
    "/runs/run-2",
  );
  assert.equal(dashboardRunHref({ run_id: "run-3" }, undefined), "/runs/run-3");
});

test("trace links stay aligned with the run at the same index", () => {
  const links = [
    { run_id: "run-new", first_trace_id: "trace-new", traces: [], parent_run_id: null, child_run_ids: [] },
    { run_id: "run-old", first_trace_id: null, traces: [], parent_run_id: null, child_run_ids: [] },
  ];
  assert.equal(linkFor(links, { run_id: "run-new" }, 0)?.first_trace_id, "trace-new");
  assert.equal(linkFor(links, { run_id: "run-old" }, 1)?.first_trace_id, null);
});

test("the reference shop is the shopping demo", () => {
  assert.equal(
    isShoppingDemo({ agent_id: "reference-shop", name: "Reference shop assistant", description: "" }),
    true,
  );
  assert.equal(
    isShoppingDemo({ agent_id: "other", name: "Planner", description: "Schedules jobs" }),
    false,
  );
});

test("dashboard has no destination strip (Security lives under Runs)", () => {
  assert.equal("DASHBOARD_DESTINATIONS" in dashboard, false);
});

test("needsAttentionRuns keeps failed/error without after_fix children", () => {
  const runs = [
    run({ run_id: "r-new-fail", status: "failed", phase: "injected" }),
    run({ run_id: "r-pass", status: "passed", phase: "baseline" }),
    run({ run_id: "r-error", status: "error", phase: "baseline" }),
    run({ run_id: "r-queued", status: "queued", phase: "baseline" }),
  ];
  const links = [
    link({ run_id: "r-new-fail", first_trace_id: "t1", child_run_ids: [] }),
    link({ run_id: "r-pass" }),
    link({ run_id: "r-error", child_run_ids: [] }),
    link({ run_id: "r-queued" }),
  ];
  const items = needsAttentionRuns(runs, links);
  assert.deepEqual(
    items.map((item) => item.run.run_id),
    ["r-new-fail", "r-error"],
  );
  assert.equal(items[0]?.link?.first_trace_id, "t1");
});

test("needsAttentionRuns excludes failed runs that already have an after_fix child", () => {
  const runs = [
    run({ run_id: "r-parent", status: "failed", phase: "injected" }),
    run({ run_id: "r-child", status: "passed", phase: "after_fix", parent_run_id: "r-parent" }),
    run({ run_id: "r-open", status: "failed", phase: "injected" }),
  ];
  const links = [
    link({ run_id: "r-parent", child_run_ids: ["r-child"] }),
    link({ run_id: "r-child", parent_run_id: "r-parent" }),
    link({ run_id: "r-open" }),
  ];
  assert.deepEqual(
    needsAttentionRuns(runs, links).map((item) => item.run.run_id),
    ["r-open"],
  );
});

test("needsAttentionRuns ignores non-after_fix children and caps at limit", () => {
  const runs = [
    run({ run_id: "r1", status: "failed", phase: "injected" }),
    run({ run_id: "r1-inj", status: "failed", phase: "injected", parent_run_id: "r1" }),
    run({ run_id: "r2", status: "error", phase: "baseline" }),
    run({ run_id: "r3", status: "failed", phase: "injected" }),
    run({ run_id: "r4", status: "failed", phase: "injected" }),
    run({ run_id: "r5", status: "failed", phase: "injected" }),
    run({ run_id: "r6", status: "failed", phase: "injected" }),
  ];
  const links = [
    link({ run_id: "r1", child_run_ids: ["r1-inj"] }),
    link({ run_id: "r1-inj", parent_run_id: "r1" }),
    link({ run_id: "r2" }),
    link({ run_id: "r3" }),
    link({ run_id: "r4" }),
    link({ run_id: "r5" }),
    link({ run_id: "r6" }),
  ];
  const items = needsAttentionRuns(runs, links, 5);
  assert.deepEqual(
    items.map((item) => item.run.run_id),
    ["r1", "r1-inj", "r2", "r3", "r4"],
  );
  assert.equal(needsAttentionRuns(runs, links, 5).length, 5);
});

test("needsAttentionRuns returns empty when nothing needs attention", () => {
  const runs = [
    run({ run_id: "ok", status: "passed", phase: "baseline" }),
    run({ run_id: "run", status: "running", phase: "injected" }),
  ];
  const links = [link({ run_id: "ok" }), link({ run_id: "run" })];
  assert.deepEqual(needsAttentionRuns(runs, links), []);
});
