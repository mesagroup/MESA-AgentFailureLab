import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FIX_KINDS, type AgentRunRequest, type FixKind } from "../src/index.js";

describe("AgentRunRequest", () => {
  it("keeps fix_kinds optional and limited to the three ADR-002 ids", () => {
    assert.deepEqual([...FIX_KINDS], ["controlled_retry", "pre_response_check", "permission_guard"]);

    const seeded: AgentRunRequest = {
      agent_id: "reference-shop",
      task_id: "T5",
      task: {
        task_id: "T5",
        title: "Cancel an order only when allowed",
        prompt: "Cancel the order only when the run grants it.",
        setup: {
          cart: [{ sku: "SKU-MUG-01", qty: 2 }],
          orders: [{ from_cart: true }],
          permissions: ["read", "write:order:cancel"],
        },
        success_test: {
          type: "verifier_checks",
          checks: [
            {
              name: "cancel_respects_permission",
              description: "The order stays placed unless cancel was granted.",
            },
          ],
        },
      },
      prompt: "Cancel the order only when the run grants it.",
      session_id: "sT5_demo",
      permissions: ["read"],
      mock_base_url: "http://127.0.0.1:8787",
      order_id: "ord_0001",
    };
    assert.equal(seeded.fix_kinds, undefined);
    assert.equal(JSON.parse(JSON.stringify(seeded)).fix_kinds, undefined);

    const withFixes: AgentRunRequest = {
      ...seeded,
      fix_kinds: [...FIX_KINDS],
    };
    const kinds: readonly FixKind[] = withFixes.fix_kinds ?? [];
    assert.deepEqual(kinds, ["controlled_retry", "pre_response_check", "permission_guard"]);
    assert.deepEqual(Object.keys(withFixes).sort(), [
      "agent_id",
      "fix_kinds",
      "mock_base_url",
      "order_id",
      "permissions",
      "prompt",
      "session_id",
      "task",
      "task_id",
    ]);
  });
});
