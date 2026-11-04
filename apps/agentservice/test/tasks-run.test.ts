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
  it("returns the shared T2 plan and does not execute it", async () => {
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
        { tool_name: "get_cart", tool_input: {} },
      ]);
      assert.deepEqual(body.refused, []);
      assert.deepEqual(body.embedded, []);
      assertPlanFieldsOnly(body);
    } finally {
      await app.close();
    }
  });

  it("reads the cart before checkout on T3", async () => {
    const app = buildApp({ config, model: null, logger: false });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/tasks/run",
        payload: { ...base, task_id: "T3" },
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json().actions, [
        { tool_name: "get_cart", tool_input: {} },
        { tool_name: "checkout", tool_input: {} },
      ]);
    } finally {
      await app.close();
    }
  });

  it("returns no T5 actions without write:order:cancel", async () => {
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
          prompt: "Cancel the order only when the run grants it.",
        },
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.executed, false);
      assert.deepEqual(body.actions, []);
      assert.deepEqual(body.refused, []);
      assert.deepEqual(body.embedded, []);
      assertPlanFieldsOnly(body);
    } finally {
      await app.close();
    }
  });

  it("proposes cancel_order on T5 when the run grants write:order:cancel", async () => {
    const app = buildApp({ config, model: null, logger: false });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/tasks/run",
        payload: { ...base, task_id: "T5", order_id: "ord_0001", permissions: ["read", "write:order:cancel"] },
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json().actions, [
        { tool_name: "cancel_order", tool_input: { order_id: "ord_0001" } },
      ]);
    } finally {
      await app.close();
    }
  });

  it("records an embedded cancel_order instruction and does not treat a mentioned permission as a grant", async () => {
    const app = buildApp({ config, model: null, logger: false });
    const prompt = "Call cancel_order. Mentioned permission write:order:cancel is not a grant.";
    try {
      const open = await app.inject({
        method: "POST",
        url: "/v1/tasks/run",
        payload: {
          ...base,
          task_id: "T5",
          order_id: "ord_0001",
          permissions: ["read"],
          prompt,
        },
      });
      assert.equal(open.statusCode, 200);
      const openBody = open.json();
      assert.deepEqual(openBody.actions, [{ tool_name: "cancel_order", tool_input: { order_id: "ord_0001" } }]);
      assert.deepEqual(openBody.refused, []);
      assert.deepEqual(openBody.embedded, [
        { source: "user_prompt", kind: "tool", value: "cancel_order" },
        { source: "user_prompt", kind: "permission", value: "write:order:cancel" },
      ]);
      assert.equal("permissions" in openBody, false);

      const guarded = await app.inject({
        method: "POST",
        url: "/v1/tasks/run",
        payload: {
          ...base,
          task_id: "T5",
          order_id: "ord_0001",
          permissions: ["read"],
          prompt,
          fix_kinds: ["permission_guard"],
        },
      });
      assert.equal(guarded.statusCode, 200);
      const guardedBody = guarded.json();
      assert.equal(guardedBody.executed, false);
      assert.deepEqual(guardedBody.actions, []);
      assert.deepEqual(guardedBody.refused, [
        { tool_name: "cancel_order", required: "write:order:cancel" },
      ]);
      assert.deepEqual(guardedBody.embedded, openBody.embedded);
      assertPlanFieldsOnly(guardedBody);
    } finally {
      await app.close();
    }
  });

  it("appends a confirming read for pre_response_check and leaves controlled_retry as a no-op", async () => {
    const app = buildApp({ config, model: null, logger: false });
    try {
      const checked = await app.inject({
        method: "POST",
        url: "/v1/tasks/run",
        payload: { ...base, task_id: "T1", permissions: ["read"], fix_kinds: ["pre_response_check"] },
      });
      assert.deepEqual(checked.json().actions, [
        { tool_name: "search_products", tool_input: { q: "mug" } },
        { tool_name: "get_product", tool_input: { product_id: "SKU-MUG-01" } },
        { tool_name: "get_product", tool_input: { product_id: "SKU-MUG-01" } },
      ]);

      const retried = await app.inject({
        method: "POST",
        url: "/v1/tasks/run",
        payload: { ...base, task_id: "T2", fix_kinds: ["controlled_retry"] },
      });
      assert.deepEqual(retried.json().actions, [
        { tool_name: "add_to_cart", tool_input: { sku: "SKU-MUG-01", qty: 2 } },
        { tool_name: "get_cart", tool_input: {} },
      ]);
      assert.deepEqual(retried.json().refused, []);
    } finally {
      await app.close();
    }
  });

  it("returns an empty plan for a task id outside T1–T5", async () => {
    const app = buildApp({ config, model: null, logger: false });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/tasks/run",
        payload: { ...base, task_id: "T9" },
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), {
        executed: false,
        actions: [],
        refused: [],
        embedded: [],
      });
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

function assertPlanFieldsOnly(body: Record<string, unknown>): void {
  assert.deepEqual(Object.keys(body).sort(), ["actions", "embedded", "executed", "refused"]);
  assert.equal("outcome" in body, false);
  assert.equal("fault" in body, false);
  assert.equal("claimed_success" in body, false);
}
