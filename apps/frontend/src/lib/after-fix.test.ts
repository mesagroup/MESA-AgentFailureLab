import assert from "node:assert/strict";
import test from "node:test";
import type { Run, Trace } from "@mesa/shared";
import {
  AFTER_FIX_SECTION_ID,
  STORYBOARD_AFTER_FIX,
  afterFixRunBody,
  beforeAfterHeadline,
  childRunsOf,
  compareBeforeAfter,
  parentChildLinks,
  parseCreateRunResults,
  runHref,
  selectableFixKinds,
  toggleFixKind,
  traceHref,
} from "./after-fix.ts";

function run(partial: Partial<Run> & Pick<Run, "run_id">): Run {
  return {
    agent_id: "reference-shop",
    task_id: "T3",
    phase: "injected",
    status: "failed",
    trace_ids: [],
    injection_plan: null,
    fix_kinds: [],
    ...partial,
  };
}

test("selectableFixKinds keeps MVP kinds from proposed_fixes and drops the rest", () => {
  assert.deepEqual(
    selectableFixKinds(["pre_response_check", "loop", "permission_guard", "pre_response_check"]),
    ["pre_response_check", "permission_guard"],
  );
  assert.deepEqual(selectableFixKinds([]), []);
  assert.deepEqual(selectableFixKinds(undefined), []);
});

test("toggleFixKind adds and removes a kind", () => {
  assert.deepEqual(toggleFixKind([], "controlled_retry"), ["controlled_retry"]);
  assert.deepEqual(toggleFixKind(["controlled_retry", "permission_guard"], "controlled_retry"), [
    "permission_guard",
  ]);
});

test("storyboard scene 8 posts after_fix for the seeded T3 parent and pre_response_check", () => {
  assert.equal(AFTER_FIX_SECTION_ID, "after-fix");
  assert.equal(STORYBOARD_AFTER_FIX.traceId, "trace-t3-forged-checkout");
  const built = afterFixRunBody({
    agentId: STORYBOARD_AFTER_FIX.agentId,
    parentRunId: STORYBOARD_AFTER_FIX.parentRunId,
    fixKinds: [STORYBOARD_AFTER_FIX.fixKind],
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.deepEqual(built.body, {
    agent_id: "reference-shop",
    phase: "after_fix",
    parent_run_id: "run-t3-injected-001",
    fix_kinds: ["pre_response_check"],
  });
  assert.equal("injection" in built.body, false);
});

test("afterFixRunBody posts after_fix with parent_run_id and fix_kinds and omits injection", () => {
  const built = afterFixRunBody({
    agentId: "reference-shop",
    parentRunId: "run-injected",
    fixKinds: ["pre_response_check", "not_a_fix"],
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.deepEqual(built.body, {
    agent_id: "reference-shop",
    phase: "after_fix",
    parent_run_id: "run-injected",
    fix_kinds: ["pre_response_check"],
  });
  assert.equal(Object.hasOwn(built.body, "injection"), false);
  assert.equal(Object.hasOwn(built.body, "task_ids"), false);
});

test("afterFixRunBody sends injection null for a clean treated replay", () => {
  const built = afterFixRunBody({
    agentId: "reference-shop",
    parentRunId: "run-injected",
    fixKinds: ["permission_guard"],
    cleanTreated: true,
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.body.injection, null);
});

test("afterFixRunBody rejects an empty selection", () => {
  const built = afterFixRunBody({
    agentId: "reference-shop",
    parentRunId: "run-injected",
    fixKinds: ["loop"],
  });
  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.match(built.message, /Select at least one proposed fix/);
});

test("parseCreateRunResults reads parent verifier, totals, and links from POST /runs", () => {
  const parsed = parseCreateRunResults({
    results: [
      {
        run: run({ run_id: "run-after", phase: "after_fix", parent_run_id: "run-parent", fix_kinds: ["pre_response_check"] }),
        trace: {
          trace_id: "trace-after",
          outcome: { verifier: { passed: true, checks: [] } },
          totals: { latency_ms: 10, cost_usd: 0.01 },
        },
        parent: {
          run: run({ run_id: "run-parent" }),
          trace: {
            trace_id: "trace-before",
            outcome: { verifier: { passed: false, checks: [] } },
            totals: { latency_ms: 20, cost_usd: 0.02 },
          },
        },
        links: {
          run: "/runs/run-after",
          trace: "/traces/trace-after",
          parent_run: "/runs/run-parent",
          parent_trace: "/traces/trace-before",
        },
      },
    ],
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.run.run_id, "run-after");
  assert.equal(parsed[0]?.trace?.trace_id, "trace-after");
  assert.equal(parsed[0]?.parent?.run.run_id, "run-parent");
  assert.equal(parsed[0]?.parent?.trace?.outcome.verifier.passed, false);
  assert.deepEqual(parsed[0]?.links, {
    run: "/runs/run-after",
    trace: "/traces/trace-after",
    parent_run: "/runs/run-parent",
    parent_trace: "/traces/trace-before",
  });
});

test("parentChildLinks read results[0].links run/trace/parent_run/parent_trace", () => {
  assert.deepEqual(
    parentChildLinks({
      links: {
        run: "/runs/run-c",
        trace: "/traces/trace-c",
        parent_run: "/runs/run-p",
        parent_trace: "/traces/trace-p",
      },
    }),
    {
      parent_run_id: "run-p",
      child_run_id: "run-c",
      parent_trace_id: "trace-p",
      child_trace_id: "trace-c",
    },
  );
  const child = run({
    run_id: "run-after",
    phase: "after_fix",
    parent_run_id: "run-before",
    trace_ids: ["trace-after"],
  });
  const parent = run({ run_id: "run-before", trace_ids: ["trace-before"] });
  assert.deepEqual(
    parentChildLinks({ parentRun: parent, childRun: child, childTrace: { trace_id: "trace-after" } as Trace }),
    {
      parent_run_id: "run-before",
      child_run_id: "run-after",
      parent_trace_id: "trace-before",
      child_trace_id: "trace-after",
    },
  );
});

test("compareBeforeAfter reports success, regressions, recovered checks, timing and cost", () => {
  const view = compareBeforeAfter({
    before: {
      verifier: {
        passed: false,
        checks: [
          { name: "order_created", passed: false, detail: "missing" },
          { name: "catalog_read", passed: true, detail: "ok" },
        ],
        mock_state_snapshot: {},
      },
      totals: { latency_ms: 1200, tokens_in: 10, tokens_out: 4, cost_usd: 0.02 },
      duration_ms: 1500,
    },
    after: {
      verifier: {
        passed: true,
        checks: [
          { name: "order_created", passed: true, detail: "created" },
          { name: "catalog_read", passed: false, detail: "gone" },
        ],
        mock_state_snapshot: {},
      },
      totals: { latency_ms: 900, tokens_in: 11, tokens_out: 5, cost_usd: 0.03 },
      duration_ms: 1100,
    },
  });
  assert.equal(view.beforePassed, false);
  assert.equal(view.afterPassed, true);
  assert.deepEqual(view.recovered, ["order_created"]);
  assert.deepEqual(view.regressions, ["catalog_read"]);
  assert.equal(view.timing.latency_ms.before, 1200);
  assert.equal(view.timing.latency_ms.after, 900);
  assert.equal(view.timing.duration_ms.after, 1100);
  assert.equal(view.timing.cost_usd.after, 0.03);
  assert.equal(beforeAfterHeadline(view), "Checks recovered: failed → passed");
  assert.equal(
    beforeAfterHeadline({ ...view, beforePassed: false, afterPassed: false, recovered: [], regressions: [] }),
    "Checks still failed after replay",
  );
});

test("childRunsOf and hrefs link parent and child runs", () => {
  const parent = run({ run_id: "run-parent" });
  const child = run({ run_id: "run-child", parent_run_id: "run-parent", phase: "after_fix" });
  assert.deepEqual(childRunsOf([parent, child], "run-parent").map((item) => item.run_id), ["run-child"]);
  assert.equal(runHref("run-parent"), "/runs/run-parent");
  assert.equal(traceHref("trace-1"), "/traces/trace-1");
});
