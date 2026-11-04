import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TraceStep } from "@mesa/shared";
import { prePass } from "../src/verifier/prepass.js";

function call(index: number, name: string, input: unknown): TraceStep {
  return {
    step_id: `step-${index}`,
    index,
    type: "tool_call",
    timestamp: "2026-11-04T10:00:00.000Z",
    role: "assistant",
    tool_name: name,
    tool_input: input,
    latency_ms: 1,
    token_usage: { input: 0, output: 0 },
    cost_usd: 0,
  };
}

describe("pre-pass", () => {
  it("flags a timeout, a repeated tool, and a same-input loop", () => {
    const steps = [call(0, "get_cart", {}), call(1, "get_cart", {}), call(2, "get_cart", {})];
    const findings = prePass({
      started_at: "2026-11-04T10:00:00.000Z",
      ended_at: "2026-11-04T10:00:31.000Z",
      steps,
      timeoutMs: 30_000,
    });
    assert.deepEqual(
      findings.map((finding) => finding.kind),
      ["timeout", "repeated_tool", "loop"],
    );
  });

  it("stays quiet on a short trace with distinct calls", () => {
    const findings = prePass({
      started_at: "2026-11-04T10:00:00.000Z",
      ended_at: "2026-11-04T10:00:01.000Z",
      steps: [call(0, "search_products", { q: "mug" }), call(1, "get_product", { product_id: "SKU-MUG-01" })],
    });
    assert.deepEqual(findings, []);
  });
});
