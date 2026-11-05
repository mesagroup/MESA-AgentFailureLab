import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { validateTrace } from "../src/validate.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const demoDir = join(root, "examples", "demo");

const expected = {
  "shop-t2-add-cart.json": { agentId: "reference-shop", taskId: "T2", tools: ["add_to_cart", "get_cart"] },
  "library-renew-loan.json": { agentId: "external-library", taskId: "renew-loan", tools: ["renew_loan", "get_loan"] },
  "library-return-loan.json": { agentId: "external-library", taskId: "return-loan", tools: ["return_loan", "get_loan"] },
  "library-place-hold.json": { agentId: "external-library", taskId: "place-hold", tools: ["place_hold"] },
} as const;

describe("demo traces", () => {
  const files = readdirSync(demoDir)
    .filter((name) => name.endsWith(".json"))
    .sort();

  it("ships shop T2 and the three library desk traces", () => {
    assert.deepEqual(files, Object.keys(expected).sort());
  });

  for (const [name, spec] of Object.entries(expected)) {
    it(`${name} validates and does not invent fault labels or diagnosis`, () => {
      const raw: unknown = JSON.parse(readFileSync(join(demoDir, name), "utf8"));
      const result = validateTrace(raw);
      assert.equal(result.ok, true, result.ok ? "" : result.errors.join("; "));
      if (!result.ok) return;
      const trace = result.value;
      assert.equal(trace.agent_id, spec.agentId);
      assert.equal(trace.task_id, spec.taskId);
      assert.equal(trace.status, "completed");
      assert.equal(trace.diagnosis, null);
      assert.equal(trace.fault.injected, false);
      assert.deepEqual(trace.fault.labels, []);
      assert.deepEqual(trace.fault.attacker, { used: false, payload_id: null });
      assert.equal(trace.outcome.success, true);
      assert.equal(trace.outcome.verifier.passed, true);
      assert.equal(trace.outcome.success, trace.outcome.verifier.passed);
      assert.deepEqual(
        trace.steps.filter((step) => step.type === "tool_call").map((step) => step.tool_name),
        [...spec.tools],
      );
    });
  }
});
