import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildApp } from "../src/app.js";
import { parseDiagnosisConfig } from "../src/grok/config.js";

const config = parseDiagnosisConfig({ XAI_API_KEY: "", GROK_MODEL: "grok-test" });

const base = {
  agent_id: "reference-shop",
  prompt: "do the task",
  session_id: "demo",
  permissions: ["read", "write:cart", "write:order", "write:order:cancel"],
  mock_base_url: "http://127.0.0.1:8787",
};

describe("POST /v1/tasks/run", () => {
  it("returns actions for the harness and does not execute them", async () => {
    const app = buildApp({ config, model: null, logger: false });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/tasks/run",
        payload: { ...base, task_id: "T2" },
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.executed, false);
      assert.deepEqual(body.actions, [
        { tool_name: "add_to_cart", tool_input: { sku: "SKU-MUG-01", qty: 2 } },
      ]);
      assert.equal("outcome" in body, false);
      assert.equal("fault" in body, false);
      assert.equal("claimed_success" in body, false);
    } finally {
      await app.close();
    }
  });

  it("accepts fix ids and leaves the action list unchanged until PR #36", async () => {
    const app = buildApp({ config, model: null, logger: false });
    try {
      const guarded = await app.inject({
        method: "POST",
        url: "/v1/tasks/run",
        payload: {
          ...base,
          task_id: "T5",
          order_id: "ord_0001",
          permissions: ["read"],
          fix_kinds: ["permission_guard", "pre_response_check", "controlled_retry"],
        },
      });
      assert.equal(guarded.statusCode, 200);
      assert.equal(guarded.json().executed, false);
      assert.deepEqual(guarded.json().actions, [
        { tool_name: "cancel_order", tool_input: { order_id: "ord_0001" } },
      ]);
      assert.equal("outcome" in guarded.json(), false);
      assert.equal("fault" in guarded.json(), false);
    } finally {
      await app.close();
    }
  });

  it("rejects an unknown fix id", async () => {
    const app = buildApp({ config, model: null, logger: false });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/tasks/run",
        payload: { ...base, task_id: "T1", fix_kinds: ["retry_controllato"] },
      });
      assert.equal(response.statusCode, 400);
    } finally {
      await app.close();
    }
  });
});
