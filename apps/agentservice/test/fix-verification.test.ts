import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verifyFix, type FixEvidence } from "../src/replay/verification.js";
import { runReplay } from "../src/replay/run.js";
import type { AttemptScore } from "../src/replay/types.js";

function good(): FixEvidence {
  return { baseline: true, before: false, after: true, expectedControls: ["a", "b"],
    controls: [{ taskId: "a", baseline: true, treated: true }, { taskId: "b", baseline: true, treated: true }] };
}

describe("fix verification from deterministic evidence", () => {
  it("requires the baseline/fault/replay contrast and the complete non-regressing control suite", () => {
    assert.equal(verifyFix(good()).fix_verified, true);
    for (const change of [{ baseline: false }, { before: true }, { after: false }]) {
      assert.equal(verifyFix({ ...good(), ...change }).fix_verified, false);
    }
    const regression = good();
    regression.controls[1].treated = false;
    assert.deepEqual({ ...verifyFix(regression), reason: "omitted" }, {
      fix_verified: false, status: "not_verified", regression: true, regressions_complete: true, reason: "omitted",
    });
  });

  it("never treats skipped/error/missing/duplicate/foreign controls as a verified fix", () => {
    for (const evidence of [
      { ...good(), baseline: null }, { ...good(), before: null }, { ...good(), after: null },
      { ...good(), controls: [] }, { ...good(), controls: good().controls.slice(1) },
      { ...good(), expectedControls: [] }, { ...good(), expectedControls: ["a", "a"] },
      { ...good(), controls: [good().controls[0], good().controls[0]] },
      { ...good(), controls: [{ taskId: "a", baseline: true, treated: null }, good().controls[1]] },
      { ...good(), controls: [{ taskId: "foreign", baseline: true, treated: true }, good().controls[1]] },
      { ...good(), controls: [{ taskId: "a", baseline: false, treated: false }, good().controls[1]] },
    ]) {
      const verdict = verifyFix(evidence);
      assert.equal(verdict.fix_verified, null);
      assert.equal(verdict.status, "inconclusive");
    }
  });

  it("also prevents a false verified claim in the legacy replay when its clean control regresses", async () => {
    const score = (passed: boolean): AttemptScore => ({ source: "backend-harness", run_id: "test-run", parent_run_id: null,
      passed, failed_checks: passed ? [] : ["product_viewed"], agent_claimed_success: true,
      latency_ms: 1, step_count: 1, tokens_in: 0, tokens_out: 0, cost_usd: 0, duration_ms: 1,
      fix_kinds_on_run: [], policy_applied_in_call_agent: false, fix_kinds_on_agent_run_request: false });
    const report = await runReplay({ tasks: ["T1"], categoryFor: () => "Verification",
      port: { run: async input => score(input.phase === "after_fix" || (input.phase === "baseline" && input.fixes.length === 0)) } });
    assert.equal(report.tasks[0].baseline.passed, true);
    assert.equal(report.tasks[0].injected_before.passed, false);
    assert.equal(report.tasks[0].injected_after.status === "ran" && report.tasks[0].injected_after.attempt.passed, true);
    assert.equal(report.tasks[0].regression, true);
    assert.equal(report.tasks[0].fix_verified, false);
  });
});
