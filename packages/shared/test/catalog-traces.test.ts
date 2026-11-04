import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { validateTrace } from "../src/validate.js";
import type { Trace } from "../src/types.js";

const examples = join(dirname(fileURLToPath(import.meta.url)), "..", "examples");

const expected = {
  "t2-wrong-argument.json": {
    taskId: "T2",
    category: "Reasoning",
    code: "wrong_argument",
    stepId: "step-1",
    fixes: [] as string[],
  },
  "t3-suppressed-readback.json": {
    taskId: "T3",
    category: "Verification",
    code: "suppressed_readback",
    stepId: "step-3",
    fixes: ["pre_response_check"],
  },
  "t5-forged-permission-success.json": {
    taskId: "T5",
    category: "Security",
    code: "forged_permission_success",
    stepId: "step-3",
    fixes: ["permission_guard"],
  },
} as const;

describe("catalog fault traces", () => {
  for (const [name, spec] of Object.entries(expected)) {
    it(`${name} is a valid Trace labeled ${spec.code}`, () => {
      const raw: unknown = JSON.parse(readFileSync(join(examples, name), "utf8"));
      const result = validateTrace(raw);
      assert.equal(result.ok, true, result.ok ? "" : result.errors.join("; "));
      if (!result.ok) return;
      const trace: Trace = result.value;
      assert.equal(trace.task_id, spec.taskId);
      assert.equal(trace.status, "failed");
      assert.equal(trace.outcome.success, trace.outcome.verifier.passed);
      assert.equal(trace.outcome.verifier.passed, false);
      assert.equal(trace.fault.injected, true);
      assert.equal(trace.fault.labels[0]?.category, spec.category);
      assert.equal(trace.fault.labels[0]?.code, spec.code);
      assert.equal(trace.fault.labels[0]?.step_id, spec.stepId);
      assert.ok(trace.steps.some((step) => step.step_id === spec.stepId));
      assert.equal(trace.diagnosis?.category, spec.category);
      assert.deepEqual(trace.diagnosis?.proposed_fixes, spec.fixes);
      const latency = trace.steps.reduce((sum, step) => sum + step.latency_ms, 0);
      const tokensIn = trace.steps.reduce((sum, step) => sum + step.token_usage.input, 0);
      const tokensOut = trace.steps.reduce((sum, step) => sum + step.token_usage.output, 0);
      assert.equal(trace.totals.latency_ms, latency);
      assert.equal(trace.totals.tokens_in, tokensIn);
      assert.equal(trace.totals.tokens_out, tokensOut);
    });
  }
});
