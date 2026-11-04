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
      assert.deepEqual(response.json(), {
        executed: false,
        claimed_success: true,
        actions: [{ tool_name: "add_to_cart", tool_input: { sku: "SKU-MUG-01", qty: 2 } }],
      });
      assert.equal("outcome" in response.json(), false);
    } finally {
      await app.close();
    }
  });

  it("blocks cancel_order when permission_guard is on and the grant is missing", async () => {
    const app = buildApp({ config, model: null, logger: false });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/tasks/run",
        payload: {
          ...base,
          task_id: "T5",
          order_id: "ord_0001",
          permissions: ["read"],
          fix_kinds: ["permission_guard"],
        },
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), {
        executed: false,
        claimed_success: false,
        actions: [],
      });
    } finally {
      await app.close();
    }
  });

  it("adds a read-back for pre_response_check and leaves controlled_retry as a no-op", async () => {
    const app = buildApp({ config, model: null, logger: false });
    try {
      const checked = await app.inject({
        method: "POST",
        url: "/v1/tasks/run",
        payload: { ...base, task_id: "T3", fix_kinds: ["pre_response_check"] },
      });
      assert.deepEqual(checked.json().actions, [
        { tool_name: "checkout", tool_input: {} },
        { tool_name: "get_cart", tool_input: {} },
      ]);

      const retried = await app.inject({
        method: "POST",
        url: "/v1/tasks/run",
        payload: { ...base, task_id: "T2", fix_kinds: ["controlled_retry"] },
      });
      assert.deepEqual(retried.json().actions, [
        { tool_name: "add_to_cart", tool_input: { sku: "SKU-MUG-01", qty: 2 } },
      ]);
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
