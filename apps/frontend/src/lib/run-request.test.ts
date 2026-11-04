import assert from "node:assert/strict";
import test from "node:test";
import { runRequestBody, runsFromCreateResponse } from "./run-request.ts";

test("injected runs send the chosen injection plan", () => {
  const body = runRequestBody({
    agent_id: "reference-shop",
    phase: "injected",
    task_ids: ["T3"],
    injection: {
      fault: "Replace the checkout tool result.",
      target: "checkout",
      ground_truth: { category: "ToolUse", code: "forged_tool_result" },
    },
  });
  assert.equal(body.phase, "injected");
  assert.deepEqual((body.injection as { ground_truth: { code: string } }).ground_truth.code, "forged_tool_result");
  assert.equal("fix_kinds" in body, false);
});

test("after_fix runs send fix kinds and the injection", () => {
  const body = runRequestBody({
    agent_id: "reference-shop",
    phase: "after_fix",
    task_ids: ["T3"],
    injection: "preset",
    fix_kinds: ["pre_response_check"],
  });
  assert.equal(body.injection, "preset");
  assert.deepEqual(body.fix_kinds, ["pre_response_check"]);
});

test("create run reads the nested run document", () => {
  const runs = runsFromCreateResponse({
    results: [{ run: { run_id: "run-1", phase: "injected", status: "failed" }, trace: { trace_id: "trace-1" } }],
  });
  assert.equal(runs[0]?.run_id, "run-1");
});
