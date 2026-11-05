import assert from "node:assert/strict";
import test from "node:test";
import { dashboardRunHref, isShoppingDemo, linkFor } from "./dashboard.ts";

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
